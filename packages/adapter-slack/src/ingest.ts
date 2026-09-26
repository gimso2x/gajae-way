import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import type { FetchLike } from "./api";
import type { SlackFileCarrier, SlackFileLike } from "./attachments";

/**
 * Receive-time image ingest.
 *
 * `url_private` needs the bot token, so the agent could never open it directly.
 * At receive time we download image attachments from Slack's own file hosts into
 * `<gateway home>/inbound-images` and stamp the saved path onto the file, so the
 * rendered attachment line carries a path the agent can `read` with no extra
 * authentication. Every failure — refused host, oversize file, transport error —
 * leaves the original file untouched so the message still renders with its
 * `url_private` line: ingest never throws and never drops the message.
 */

/** `url_private` is served only by Slack's own file hosts; anything else is never fetched. */
const SLACK_FILE_HOSTS: ReadonlySet<string> = new Set(["files.slack.com", "files-origin.slack.com"]);
/** Per-image disk budget; a larger attachment keeps its url_private line instead. */
export const MAX_INBOUND_IMAGE_BYTES = 20 * 1024 * 1024;
/** Matches the renderer's 10-attachment cap: only rendered files are downloaded. */
export const MAX_INGESTED_FILES = 10;
/** One hung file host must not stall the conversation's ingress lane forever. */
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Saved images are conversation input, not an archive: pruned by age, then by total size. */
export const INBOUND_IMAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const INBOUND_IMAGE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export interface IngestOptions {
	readonly botToken: string;
	readonly home: string;
	readonly fetcher?: FetchLike;
	readonly now?: () => number;
	readonly limit?: number;
	readonly log?: Pick<Console, "error">;
}

export type SavedPath = string;

/**
 * Downloads the image attachments of one inbound message and returns the message
 * with `localPath` stamped on every file that was saved. Only the files the
 * renderer would show (the first `MAX_INGESTED_FILES`) are downloaded.
 */
export async function ingestInboundImages<T extends SlackFileCarrier>(message: T, options: IngestOptions): Promise<T> {
	const files = message.files ?? [];
	if (files.length === 0) return message;
	// Attachment metadata is echoed into rendered bodies and saved filenames: the
	// bot token value must never survive into either, whatever the metadata says.
	// `localPath` is ingest-owned: an inbound value is never trusted or rendered.
	const safe = scrubbedFiles(files, options.botToken);
	const limit = options.limit ?? MAX_INBOUND_IMAGE_BYTES;
	const targets = safe.slice(0, MAX_INGESTED_FILES).filter((file) => downloadableImage(file, limit));
	const saved = new Map<SlackFileLike, SavedPath>();
	if (targets.length > 0) {
		const dir = join(options.home, "inbound-images");
		for (const file of targets) {
			const path = await downloadAndSave(file, options, dir, limit);
			if (path) saved.set(file, path);
		}
		if (saved.size > 0) await pruneInboundImages(dir, { now: options.now });
	}
	return {
		...message,
		files: safe.map((file) => {
			const path = saved.get(file);
			return path ? { ...file, localPath: path } : file;
		}),
	} as T;
}

/**
 * Drops everything the renderer must not echo: malformed file entries, the
 * credential value in any rendered field (names, titles, url fallbacks), and
 * any inbound `localPath` — that field is ingest-owned. Returns the same array
 * when every file was clean.
 */
export function scrubbedFiles<C extends readonly SlackFileLike[] | null | undefined>(files: C, token: string): C {
	// `files` itself may be any hostile JSON value: only a real array is processed.
	if (!Array.isArray(files)) return [] as unknown as C;
	return files
		.map((file) => (isValidFile(file) ? withoutCredential(file, token) : null))
		.filter((file): file is SlackFileLike => file !== null) as unknown as C;
}

function isValidFile(file: SlackFileLike): boolean {
	return Boolean(file) && typeof file === "object";
}

function leaksCredential(file: SlackFileLike, token: string): boolean {
	if (!isValidFile(file)) return false;
	return (
		file.localPath !== undefined ||
		[file.name, file.title, file.url_private, file.permalink].some(
			(value) => typeof value === "string" && value.includes(token),
		)
	);
}

function withoutCredential(file: SlackFileLike, token: string): SlackFileLike {
	const { localPath: _untrusted, ...rest } = file;
	const name = redactCredential(rest.name, token);
	const title = redactCredential(rest.title, token);
	const url_private = redactCredential(rest.url_private, token);
	const permalink = redactCredential(rest.permalink, token);
	const unchanged =
		name === rest.name &&
		title === rest.title &&
		url_private === rest.url_private &&
		permalink === rest.permalink &&
		_untrusted === undefined;
	if (unchanged) return file;
	return {
		...rest,
		...(name === file.name ? {} : { name }),
		...(title === file.title ? {} : { title }),
		...(url_private === file.url_private ? {} : { url_private }),
		...(permalink === file.permalink ? {} : { permalink }),
	};
}

function redactCredential(value: string | null | undefined, token: string): string | null | undefined {
	if (typeof value !== "string" || !value.includes(token)) return value;
	return value.replaceAll(token, "[redacted]");
}

/** Age-and-size retention over one ingest directory; partial failures never remove the newest input. */
export async function pruneInboundImages(
	dir: string,
	options: { now?: () => number; maxAgeMs?: number; maxTotalBytes?: number } = {},
): Promise<void> {
	const entries = await readdir(dir, { withFileTypes: true }).catch(() => undefined);
	if (!entries) return;
	const now = options.now ?? Date.now;
	const maxAgeMs = options.maxAgeMs ?? INBOUND_IMAGE_MAX_AGE_MS;
	const maxTotalBytes = options.maxTotalBytes ?? INBOUND_IMAGE_MAX_TOTAL_BYTES;
	const kept: { name: string; mtimeMs: number; size: number }[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) continue;
		try {
			const info = await stat(join(dir, entry.name));
			if (now() - info.mtimeMs > maxAgeMs) await unlink(join(dir, entry.name)).catch(() => {});
			else kept.push({ name: entry.name, mtimeMs: info.mtimeMs, size: info.size });
		} catch {
			// A concurrent prune already removed it; nothing to account.
		}
	}
	let total = kept.reduce((sum, file) => sum + file.size, 0);
	if (total <= maxTotalBytes) return;
	for (const file of kept.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
		if (total <= maxTotalBytes) break;
		try {
			await unlink(join(dir, file.name));
			total -= file.size;
		} catch {
			// Already gone; the next pass reconciles the accounting.
		}
	}
}

/** An image Slack itself hosts, small enough to be worth a download attempt. */
function downloadableImage(file: SlackFileLike, limit: number): boolean {
	// Metadata is attacker-controlled and may not even be a string: coerce safely,
	// because a throw here would drop the message instead of degrading it.
	if (!asText(file.mimetype).toLowerCase().startsWith("image/")) return false;
	if (typeof file.size === "number" && Number.isFinite(file.size) && file.size > limit) return false;
	try {
		const { protocol, hostname } = new URL(asText(file.url_private));
		return protocol === "https:" && SLACK_FILE_HOSTS.has(hostname);
	} catch {
		return false;
	}
}

/** Never throws, whatever the inbound metadata type was. */
function asText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

async function downloadAndSave(
	file: SlackFileLike,
	options: IngestOptions,
	dir: string,
	limit: number,
): Promise<SavedPath | undefined> {
	const log = options.log ?? console;
	try {
		const bytes = await fetchCapped(
			file.url_private as string,
			{ Authorization: `Bearer ${options.botToken}` },
			limit,
			options.fetcher ?? fetch,
		);
		if (!bytes) return undefined;
		await mkdir(dir, { recursive: true });
		const path = resolve(join(dir, fileName(file, options.now ?? Date.now)));
		// A token-bearing gateway home must never leak through the saved path.
		if (path.includes(options.botToken)) return undefined;
		if (!path.startsWith(resolve(dir))) return undefined;
		await writeFile(path, bytes);
		return path;
	} catch (error) {
		const raw = errorText(error);
		// Nothing an error object carries (e.g. an ENOTDIR path) may echo the token.
		const detail = raw.includes(options.botToken) ? "error text withheld (contained the bot token)" : raw;
		log.error(`Slack image ingest failed for ${hostOf(file.url_private)}; keeping the url line: ${detail}`);
		return undefined;
	}
}

/** Streams at most `limit` bytes; a host that lies about content-length is cut off mid-stream. */
async function fetchCapped(
	url: string,
	headers: Record<string, string>,
	limit: number,
	fetcher: FetchLike,
): Promise<Uint8Array | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
	try {
		// Never follow redirects: a files.slack.com url must not bounce the
		// Authorization header, or the download, to some other host.
		const response = await fetcher(url, { headers, signal: controller.signal, redirect: "manual" });
		if (!response.ok) return undefined;
		const declared = Number(response.headers.get("content-length"));
		if (Number.isFinite(declared) && declared > limit) return undefined;
		const reader = response.body?.getReader();
		if (!reader) return undefined;
		const chunks: Uint8Array[] = [];
		let total = 0;
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				void reader.cancel().catch(() => {});
				return undefined;
			}
			chunks.push(value);
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return bytes;
	} catch {
		return undefined;
	} finally {
		clearTimeout(timer);
	}
}

/** Timestamp, randomness and a sanitized display name; never any credential material. */
function fileName(file: SlackFileLike, now: () => number): string {
	const base = basename(file.name ?? file.title ?? "image")
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[-.]+/, "")
		.slice(0, 80);
	const nameExt = extname(base);
	const ext = nameExt || extensionFor(file.mimetype);
	const stem = (nameExt ? base.slice(0, base.length - nameExt.length) : base) || "image";
	return `slack-${now()}-${randomUUID().slice(0, 8)}-${stem}${ext}`;
}

function extensionFor(mimetype: string | null | undefined): string {
	const subtype = (mimetype ?? "").split("/")[1] ?? "";
	return /^[a-z0-9]{1,8}$/.test(subtype) ? `.${subtype}` : ".img";
}

function hostOf(url: string | null | undefined): string {
	try {
		return new URL(url ?? "").hostname;
	} catch {
		return "unknown host";
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
