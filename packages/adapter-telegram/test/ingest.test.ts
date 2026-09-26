import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
	inboundImage,
	largestPhoto,
	pruneInboundImages,
	type TelegramDocument,
	type TelegramFileSource,
	TelegramImageIngest,
	type TelegramPhotoSize,
} from "../src/ingest";

// A realistic-looking but fake token: proves no ingest output ever carries the value.
const TOKEN = "12345:AAExample-Token-Value";
type Calls = { fileIds: string[]; urls: string[] };

const emptyCalls = (): Calls => ({ fileIds: [], urls: [] });

const photoMessage = {
	caption: "look at this",
	photo: [
		{ file_id: "small", width: 90, height: 90, file_size: 3 },
		{ file_id: "large", width: 1280, height: 960, file_size: 10 },
	],
};

function fakeSource(
	options: { filePath?: string | null; body?: string; status?: number } = {},
	calls: { fileIds: string[]; urls: string[] } = { fileIds: [], urls: [] },
): TelegramFileSource {
	return {
		token: TOKEN,
		fetcher: async (input) => {
			calls.urls.push(String(input));
			return new Response(options.body ?? "jpeg-bytes", { status: options.status ?? 200 });
		},
		getFile: async (fileId) => {
			calls.fileIds.push(fileId);
			// filePath: null simulates Telegram refusing to resolve a download path.
			return { file_path: options.filePath === null ? undefined : (options.filePath ?? "photos/file_1.jpg") };
		},
	};
}

async function temporaryHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "gajaeway-telegram-ingest-"));
}

test("saves the largest photo and renders caption plus the saved path", async () => {
	const home = await temporaryHome();
	try {
		const calls = emptyCalls();
		const ingest = new TelegramImageIngest(fakeSource({ body: "jpeg-bytes" }, calls), home);
		const body = await ingest.bodyFor(photoMessage);
		expect(calls.fileIds).toEqual(["large"]);
		expect(calls.urls).toEqual([`https://api.telegram.org/file/bot${TOKEN}/photos/file_1.jpg`]);
		const lines = body.split("\n");
		expect(lines[0]).toBe("look at this");
		expect(lines[1]).toMatch(
			/^\[image · photo\.jpg · 10 B · .+\/inbound-images\/telegram-\d+-[0-9a-f]{8}-photo\.jpg\]$/,
		);
		const saved = (lines[1]?.split(" · ")[3] ?? "").replace(/\]$/, "");
		expect(await readFile(saved, "utf8")).toBe("jpeg-bytes");
		// Saved handles are absolute so history redaction can find them.
		expect(isAbsolute(saved)).toBe(true);
		// The token lives only in the fetch URL path; it never reaches the body or a filename.
		expect(body).not.toContain(TOKEN);
		for (const name of await readdir(join(home, "inbound-images"))) expect(name).not.toContain(TOKEN);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a captionless photo still renders a body and is never dropped", async () => {
	const home = await temporaryHome();
	try {
		const ingest = new TelegramImageIngest(fakeSource(), home);
		const body = await ingest.bodyFor({ photo: [{ file_id: "large", width: 10, height: 10 }] });
		expect(body).toMatch(/^\[image · photo\.jpg · image · .+\.jpg\]$/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("an image document is saved under its own name; a non-image document never downloads", async () => {
	const home = await temporaryHome();
	try {
		const calls = emptyCalls();
		const ingest = new TelegramImageIngest(fakeSource({ body: "png-bytes" }, calls), home);
		const body = await ingest.bodyFor({
			caption: "doc",
			document: { file_id: "d1", file_name: "pic.png", mime_type: "image/png", file_size: 9 },
		});
		expect(calls.fileIds).toEqual(["d1"]);
		expect(body).toMatch(/^doc\n\[image · pic\.png · 9 B · .+\/inbound-images\/telegram-\d+-[0-9a-f]{8}-pic\.png\]$/);
		expect(await ingest.bodyFor({ document: { file_id: "d2", mime_type: "application/pdf" } })).toBe("");
		expect(calls.fileIds).toEqual(["d1"]);
		expect(largestPhoto(undefined)).toBeUndefined();
		expect(inboundImage({})).toBeUndefined();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a failed download keeps the caption and an unpathed image line, and never the token", async () => {
	const home = await temporaryHome();
	try {
		const logs: string[] = [];
		const ingest = new TelegramImageIngest(fakeSource({ filePath: null }), home, {
			log: { error: (message) => void logs.push(message) },
		});
		const body = await ingest.bodyFor(photoMessage);
		expect(body).toBe("look at this\n[image · photo.jpg · 10 B]");
		expect(logs).toHaveLength(1);
		expect(logs[0]).not.toContain(TOKEN);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("an oversized image is never fetched: the declared size short-circuits before getFile", async () => {
	const home = await temporaryHome();
	try {
		const calls = emptyCalls();
		const ingest = new TelegramImageIngest(fakeSource({}, calls), home, { limit: 8 });
		const body = await ingest.bodyFor(photoMessage);
		expect(calls.fileIds).toEqual([]);
		expect(calls.urls).toEqual([]);
		expect(body).toBe("look at this\n[image · photo.jpg · 10 B]");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a token-bearing gateway home path never reaches the body", async () => {
	const base = await temporaryHome();
	try {
		const home = join(base, TOKEN, "home");
		const ingest = new TelegramImageIngest(fakeSource({ filePath: "docs/file_1.jpg" }), home);
		const body = await ingest.bodyFor({ photo: [{ file_id: "large", width: 10, height: 10 }] });
		expect(body).toBe("[image · photo.jpg · image]");
		expect(body).not.toContain(TOKEN);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("malformed metadata types degrade instead of throwing", async () => {
	const home = await temporaryHome();
	try {
		const calls = emptyCalls();
		const ingest = new TelegramImageIngest(fakeSource({}, calls), home);
		const body = await ingest.bodyFor({
			caption: "kept",
			document: { file_id: "d9", file_name: "pic.png", mime_type: 5 as unknown as string },
		});
		expect(body).toBe("kept");
		expect(calls.fileIds).toEqual([]);
		const sized = await ingest.bodyFor({
			document: { file_id: "d8", mime_type: "image/png", file_size: "9" as unknown as number },
		});
		expect(sized).toMatch(/^\[image · photo · image · .+\/inbound-images\/telegram-\d+-[0-9a-f]{8}-photo\.png\]$/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("hostile photo arrays and document values degrade instead of throwing", async () => {
	const home = await temporaryHome();
	try {
		const ingest = new TelegramImageIngest(fakeSource({ body: "bytes", filePath: "docs/file_1.jpg" }), home);
		// document: null used to throw inside imageDocument.
		expect(inboundImage({ document: null as unknown as TelegramDocument })).toBeUndefined();
		// A photo entry with a hostile width object used to throw in pixels().
		const hostile = await ingest.bodyFor({
			photo: [
				null,
				{ file_id: "ok", width: { valueOf: null } as unknown as number, height: 2, file_size: 1 },
			] as unknown as readonly TelegramPhotoSize[],
		});
		expect(hostile).toMatch(/^\[image · photo\.jpg · 1 B · .+\/inbound-images\/telegram-\d+-[0-9a-f]{8}-photo\.jpg\]$/);
		// A nonnumeric size on the winning photo is treated as unknown, not fatal.
		const unpathed = await ingest.bodyFor({
			photo: [{ file_id: "x", width: 1, height: 1, file_size: "9" as unknown as number }],
		});
		expect(unpathed).toMatch(
			/^\[image · photo\.jpg · image · .+\/inbound-images\/telegram-\d+-[0-9a-f]{8}-photo\.jpg\]$/,
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("hostile width/height objects on photo variants cannot throw", async () => {
	const home = await temporaryHome();
	try {
		const ingest = new TelegramImageIngest(fakeSource({ body: "bytes", filePath: "docs/file_1.jpg" }), home);
		const hostile = await ingest.bodyFor({
			photo: [
				{
					file_id: "bad",
					width: { valueOf: null, toString: null } as unknown as number,
					height: { valueOf: null, toString: null } as unknown as number,
				},
				{ file_id: "good", width: 3, height: 4, file_size: 1 },
			],
		});
		expect(hostile).toMatch(/^\[image · photo\.jpg · 1 B · .+\/inbound-images\/telegram-\d+-[0-9a-f]{8}-photo\.jpg\]$/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a hostile caption type degrades to the image line instead of throwing", async () => {
	const home = await temporaryHome();
	try {
		const ingest = new TelegramImageIngest(fakeSource({ body: "jpeg", filePath: "docs/file_1.jpg" }), home);
		const body = await ingest.bodyFor({
			caption: 7 as unknown as string,
			photo: [{ file_id: "p", width: 1, height: 1 }],
		});
		expect(body).toMatch(/^\[image · photo\.jpg · image · .+\/inbound-images\/telegram-\d+-[0-9a-f]{8}-photo\.jpg\]$/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("an attachment name carrying the bot token is scrubbed from body, filename and logs", async () => {
	const home = await temporaryHome();
	try {
		const logs: string[] = [];
		const ingest = new TelegramImageIngest(fakeSource({ body: "png-bytes", filePath: "docs/file_1.jpg" }), home, {
			log: { error: (message) => void logs.push(message) },
		});
		const body = await ingest.bodyFor({
			document: { file_id: "d9", file_name: `leak-${TOKEN}.png`, mime_type: "image/png", file_size: 5 },
		});
		expect(body).not.toContain(TOKEN);
		expect(body).toContain("[redacted]");
		for (const name of await readdir(join(home, "inbound-images"))) expect(name).not.toContain(TOKEN);
		const failing = new TelegramImageIngest(fakeSource({ filePath: null }), home, {
			log: { error: (message) => void logs.push(message) },
		});
		const failed = await failing.bodyFor({
			document: { file_id: "d8", file_name: `oops-${TOKEN}.png`, mime_type: "image/png" },
		});
		expect(failed).not.toContain(TOKEN);
		expect(logs.join("\n")).not.toContain(TOKEN);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a stream that grows past the limit mid-download is cut off", async () => {
	const home = await temporaryHome();
	try {
		const calls = emptyCalls();
		const ingest = new TelegramImageIngest(
			fakeSource({ body: "x".repeat(100), filePath: "photos/file_1.jpg" }, calls),
			home,
			{ limit: 8 },
		);
		const body = await ingest.bodyFor({ photo: [{ file_id: "large", width: 10, height: 10 }] });
		expect(calls.urls).toHaveLength(1);
		expect(body).toBe("[image · photo.jpg · image]");
		await expect(readdir(join(home, "inbound-images"))).rejects.toThrow();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("prune removes files older than the age limit before counting size", async () => {
	const home = await temporaryHome();
	const images = join(home, "inbound-images");
	try {
		await mkdir(images, { recursive: true });
		const now = 1_000_000_000_000;
		const old = join(images, "telegram-old.png");
		const fresh = join(images, "telegram-fresh.png");
		await writeFile(old, "a");
		await writeFile(fresh, "b");
		await utimes(old, new Date(now - 2_000), new Date(now - 2_000));
		await utimes(fresh, new Date(now), new Date(now));
		await pruneInboundImages(images, { now: () => now, maxAgeMs: 1_000 });
		expect(await readdir(images)).toEqual(["telegram-fresh.png"]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("prune deletes oldest-first until the directory fits the byte budget", async () => {
	const home = await temporaryHome();
	const images = join(home, "inbound-images");
	try {
		await mkdir(images, { recursive: true });
		const now = 1_000_000_000_000;
		const oldest = join(images, "telegram-1.png");
		const middle = join(images, "telegram-2.png");
		const newest = join(images, "telegram-3.png");
		await writeFile(oldest, "x".repeat(10));
		await writeFile(middle, "x".repeat(20));
		await writeFile(newest, "x".repeat(5));
		await utimes(oldest, new Date(now - 30), new Date(now - 30));
		await utimes(middle, new Date(now - 20), new Date(now - 20));
		await utimes(newest, new Date(now - 10), new Date(now - 10));
		await pruneInboundImages(images, { now: () => now, maxTotalBytes: 25 });
		expect([...(await readdir(images))].sort()).toEqual(["telegram-2.png", "telegram-3.png"]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a missing ingest directory prunes to a no-op", async () => {
	const home = await temporaryHome();
	try {
		await expect(pruneInboundImages(join(home, "inbound-images"))).resolves.toBeUndefined();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a caption carrying the bot token is scrubbed from the body", async () => {
	const home = await temporaryHome();
	try {
		const ingest = new TelegramImageIngest(fakeSource(), home);
		const body = await ingest.bodyFor({ caption: `hi ${TOKEN}`, photo: [{ file_id: "p", width: 1, height: 1 }] });
		expect(body).not.toContain(TOKEN);
		expect(body).toContain("[redacted]");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
