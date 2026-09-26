import { randomUUID } from "node:crypto";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
/** The subset of an inbound Telegram message the ingest reads; `TelegramMessage` satisfies it. */
export interface IngestMessageShape {
	readonly text?: string;
	readonly caption?: string;
	readonly photo?: readonly TelegramPhotoSize[];
	readonly document?: TelegramDocument;
}

export type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Receive-time image ingest for Telegram.
 *
 * Telegram photo and image-document bytes live behind `getFile` + a bot-token
 * file URL, so the agent could never open them directly. At receive time we
 * download them into `<gateway home>/inbound-images` and render the saved path
 * into the message body next to the caption. Every failure leaves the message
 * renderable without a path: ingest never throws and never drops the message.
 */

/** Per-image disk budget; a larger attachment is described without a path instead. */
export const MAX_INBOUND_IMAGE_BYTES = 20 * 1024 * 1024;
/** One hung file host must not stall the polling loop forever. */
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** Saved images are conversation input, not an archive: pruned by age, then by total size. */
export const INBOUND_IMAGE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const INBOUND_IMAGE_MAX_TOTAL_BYTES = 512 * 1024 * 1024;

export interface TelegramPhotoSize {
	readonly file_id: string;
	readonly file_unique_id?: string;
	readonly width?: number;
	readonly height?: number;
	readonly file_size?: number;
}

export interface TelegramDocument {
	readonly file_id: string;
	readonly file_unique_id?: string;
	readonly file_name?: string;
	readonly mime_type?: string;
	readonly file_size?: number;
}

/** The bot API surface the ingest needs; `TelegramBotApi` implements it. */
export interface TelegramFileSource {
	readonly token: string;
	readonly fetcher: Fetcher;
	getFile(fileId: string): Promise<{ file_path?: string }>;
}

export interface IngestImage {
	readonly fileId: string;
	readonly name?: string;
	readonly mimetype?: string;
	readonly size?: number;
}

/** The largest photo variant Telegram attached, or undefined when there is no photo. */
export function largestPhoto(photo?: readonly TelegramPhotoSize[]): TelegramPhotoSize | undefined {
	// `photo` is inbound data: it may be missing, not an array, or hold junk entries.
	if (!Array.isArray(photo)) return undefined;
	const valid = photo.filter(
		(size): size is TelegramPhotoSize => Boolean(size) && typeof size === "object" && typeof size.file_id === "string",
	);
	if (valid.length === 0) return undefined;
	return valid.reduce((best, size) => (best === undefined || pixels(size) > pixels(best) ? size : best));
}

function pixels(size: TelegramPhotoSize): number {
	// Hostile width/height values (objects overriding valueOf/toString) must not
	// throw in ToPrimitive conversion: only real numbers count.
	const width = typeof size.width === "number" && Number.isFinite(size.width) ? size.width : 0;
	const height = typeof size.height === "number" && Number.isFinite(size.height) ? size.height : 0;
	return width * height;
}

/** An image document (mimetype `image/*`); other documents keep their current text-only behavior. */
export function imageDocument(document?: TelegramDocument): TelegramDocument | undefined {
	// Metadata may be any JSON value, including null: coerce safely, a throw here
	// would drop the message instead of degrading it.
	return document != null &&
		typeof document.mime_type === "string" &&
		document.mime_type.toLowerCase().startsWith("image/")
		? document
		: undefined;
}

/** One download target for a message: the largest photo, else the image document. */
export function inboundImage(message: IngestMessageShape): IngestImage | undefined {
	const photo = largestPhoto(message.photo);
	if (photo) return { fileId: photo.file_id, size: photo.file_size, name: "photo.jpg", mimetype: "image/jpeg" };
	const document = imageDocument(message.document);
	if (document && typeof document.file_id === "string")
		return {
			fileId: document.file_id,
			name: typeof document.file_name === "string" ? document.file_name : undefined,
			mimetype: typeof document.mime_type === "string" ? document.mime_type : undefined,
			size: typeof document.file_size === "number" ? document.file_size : undefined,
		};
	return undefined;
}

export interface IngestOptions {
	readonly now?: () => number;
	readonly limit?: number;
	readonly log?: Pick<Console, "error">;
}

/**
 * Renders one inbound message body: caption text plus, for images, the saved
 * file path the agent can read without extra authentication. Download failures
 * keep the caption and an unpathed `[image · …]` line, mirroring the Slack
 * adapter's fallback, and never include the bot token.
 */
export class TelegramImageIngest {
	constructor(
		private readonly source: TelegramFileSource,
		private readonly home: string,
		private readonly options: IngestOptions = {},
	) {}

	async bodyFor(message: IngestMessageShape): Promise<string> {
		// `text`/`caption` are inbound data and may be any JSON value: coerce before
		// use, because a throw here would permanently lose the already-acked update.
		const caption = withoutCredential(asText(message.text ?? message.caption), this.source.token);
		const image = inboundImage(message);
		if (!image) return caption;
		// Attachment names are echoed into the body and the saved filename: the bot
		// token value must never survive into either, whatever the metadata says.
		const name = withoutCredential(describeName(image), this.source.token);
		const limit = this.options.limit ?? MAX_INBOUND_IMAGE_BYTES;
		if (typeof image.size === "number" && Number.isFinite(image.size) && image.size > limit)
			return bodyWith(caption, `[image · ${name} · ${formatSize(image.size)}]`);
		const path = await this.#save(image, name, limit);
		const line = path
			? `[image · ${name} · ${formatSize(image.size)} · ${path}]`
			: `[image · ${name} · ${formatSize(image.size)}]`;
		return bodyWith(caption, line);
	}

	async #save(image: IngestImage, name: string, limit: number): Promise<string | undefined> {
		const log = this.options.log ?? console;
		const dir = join(this.home, "inbound-images");
		try {
			const info = await this.source.getFile(image.fileId);
			const filePath = info.file_path;
			// The token travels in the URL path (Telegram's design); it is never logged.
			if (!filePath || !/^[A-Za-z0-9/_.-]+$/.test(filePath)) throw new Error("getFile returned no usable file path");
			const bytes = await fetchCapped(
				`https://api.telegram.org/file/bot${this.source.token}/${filePath}`,
				limit,
				this.source.fetcher,
			);
			if (!bytes) return undefined;
			await mkdir(dir, { recursive: true });
			const path = resolve(join(dir, fileName(name, image.mimetype, this.options.now ?? Date.now)));
			// A token-bearing gateway home must never leak through the saved path.
			if (path.includes(this.source.token)) return undefined;
			if (!path.startsWith(resolve(dir))) return undefined;
			await writeFile(path, bytes);
			await pruneInboundImages(dir, { now: this.options.now });
			return path;
		} catch (error) {
			const raw = errorText(error);
			// Belt and braces: nothing an error object carries may ever echo the token.
			const detail = raw.includes(this.source.token) ? "error text withheld (contained the bot token)" : raw;
			log.error(`Telegram image ingest failed for ${name}; keeping the unpathed image line: ${detail}`);
			return undefined;
		}
	}
}

function bodyWith(caption: string, line: string): string {
	return caption.trim() === "" ? line : `${caption}\n${line}`;
}

/** Never throws, whatever the inbound metadata type was. */
export function asText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Drops the credential value from the file metadata the renderer will echo. */
function withoutCredential(value: string, token: string): string {
	return value.includes(token) ? value.replaceAll(token, "[redacted]") : value;
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

/** Streams at most `limit` bytes; a host that lies about content-length is cut off mid-stream. */
async function fetchCapped(url: string, limit: number, fetcher: Fetcher): Promise<Uint8Array | undefined> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
	try {
		// Never follow redirects: the file url embeds the bot token in its path,
		// and a bounce would hand it to whatever host the redirect points at.
		const response = await fetcher(url, { signal: controller.signal, redirect: "manual" });
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
function fileName(name: string, mimetype: string | undefined, now: () => number): string {
	const base = basename(name)
		.replace(/[^A-Za-z0-9._-]+/g, "-")
		.replace(/^[-.]+/, "")
		.slice(0, 80);
	const nameExt = extname(base);
	const ext = nameExt || extensionFor(mimetype);
	const stem = (nameExt ? base.slice(0, base.length - nameExt.length) : base) || "image";
	return `telegram-${now()}-${randomUUID().slice(0, 8)}-${stem}${ext}`;
}

function extensionFor(mimetype: string | undefined): string {
	const subtype = (mimetype ?? "").split("/")[1] ?? "";
	return /^[a-z0-9]{1,8}$/.test(subtype) ? `.${subtype}` : ".img";
}

function describeName(image: IngestImage): string {
	return image.name ?? "photo";
}

function formatSize(size: number | undefined): string {
	if (typeof size !== "number" || !Number.isFinite(size) || size < 0) return "image";
	if (size < 1024) return `${Math.round(size)} B`;
	if (size < 1024 * 1024) return `${Math.round((size / 1024) * 10) / 10} KB`;
	return `${Math.round((size / (1024 * 1024)) * 10) / 10} MB`;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
