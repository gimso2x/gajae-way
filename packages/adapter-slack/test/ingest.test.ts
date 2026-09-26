import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describeInboundBody, type SlackFileLike } from "../src/attachments";
import { ingestInboundImages, MAX_INGESTED_FILES, pruneInboundImages } from "../src/ingest";
import { renderInboundText, type SlackInboundMessage } from "../src/main";

// A realistic-looking but fake token: proves no ingest output ever carries the value.
const TOKEN = "xoxb-example-token-value";

const imageFile = {
	name: "photo.png",
	mimetype: "image/png",
	size: 9,
	url_private: "https://files.slack.com/files-pri/T1/F1/photo.png",
};

interface Calls {
	urls: string[];
	authorizations: (string | null)[];
}

function fakeFetcher(
	options: { body?: string; status?: number } = {},
	calls: Calls = { urls: [], authorizations: [] },
) {
	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		calls.urls.push(String(input));
		calls.authorizations.push(new Headers(init?.headers).get("Authorization"));
		return new Response(options.body ?? "png-bytes", { status: options.status ?? 200 });
	};
}

async function temporaryHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "gajaeway-slack-ingest-"));
}

test("downloads image attachments with the bot token and puts the saved path in the body", async () => {
	const home = await temporaryHome();
	try {
		const calls: Calls = { urls: [], authorizations: [] };
		const enriched = await ingestInboundImages(
			{ text: "caption", files: [imageFile] },
			{ botToken: TOKEN, home, fetcher: fakeFetcher({}, calls) },
		);
		expect(calls.urls).toEqual(["https://files.slack.com/files-pri/T1/F1/photo.png"]);
		expect(calls.authorizations[0]).toBe(`Bearer ${TOKEN}`);
		const body = describeInboundBody(enriched);
		expect(body).toMatch(
			/^caption\n\[image · photo\.png · 9 B · .+\/inbound-images\/slack-\d+-[0-9a-f]{8}-photo\.png\]$/,
		);
		const saved = (body.split(" · ")[3] ?? "").replace(/\]$/, "");
		expect(await readFile(saved, "utf8")).toBe("png-bytes");
		// The token rides only in the Authorization header; it never reaches the body or a filename.
		expect(body).not.toContain(TOKEN);
		for (const name of await readdir(join(home, "inbound-images"))) expect(name).not.toContain(TOKEN);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a token-bearing gateway home path never reaches the body", async () => {
	const base = await temporaryHome();
	try {
		const home = join(base, TOKEN, "home");
		const enriched = await ingestInboundImages(
			{ files: [imageFile] },
			{ botToken: TOKEN, home, fetcher: fakeFetcher() },
		);
		const body = describeInboundBody(enriched);
		expect(body).toBe(`[image · photo.png · 9 B · ${imageFile.url_private}]`);
		expect(body).not.toContain(TOKEN);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("a malformed file entry is dropped while valid attachments still reach the gateway", async () => {
	const home = await temporaryHome();
	try {
		const calls: Calls = { urls: [], authorizations: [] };
		const enriched = await ingestInboundImages(
			{ text: "with attachment", files: [null as unknown as SlackFileLike, imageFile] },
			{ botToken: TOKEN, home, fetcher: fakeFetcher({}, calls) },
		);
		expect(calls.urls).toEqual([imageFile.url_private]);
		const body = describeInboundBody(enriched);
		const lines = body.split("\n");
		expect(lines).toHaveLength(2);
		expect(lines[0]).toBe("with attachment");
		expect(lines[1]).toMatch(/inbound-images\/slack-\d+-[0-9a-f]{8}-photo\.png\]$/);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a filesystem error that embeds the home path still never logs the token", async () => {
	const base = await temporaryHome();
	try {
		const home = join(base, TOKEN, "home");
		await mkdir(dirname(home), { recursive: true });
		await writeFile(home, "not a directory");
		const logs: string[] = [];
		const enriched = await ingestInboundImages(
			{ files: [imageFile] },
			{
				botToken: TOKEN,
				home,
				fetcher: fakeFetcher({}, { urls: [], authorizations: [] }),
				log: { error: (message) => void logs.push(message) },
			},
		);
		expect(describeInboundBody(enriched)).toBe(`[image · photo.png · 9 B · ${imageFile.url_private}]`);
		expect(logs.join("\n")).toContain("withheld");
		expect(logs.join("\n")).not.toContain(TOKEN);
	} finally {
		await rm(base, { recursive: true, force: true });
	}
});

test("a non-array files value drops the attachments but keeps the text", async () => {
	const home = await temporaryHome();
	try {
		const calls: Calls = { urls: [], authorizations: [] };
		const enriched = await ingestInboundImages(
			{ text: "keep me", files: {} as unknown as SlackFileLike[] },
			{ botToken: TOKEN, home, fetcher: fakeFetcher({}, calls) },
		);
		expect(describeInboundBody(enriched)).toBe("keep me");
		expect(calls.urls).toEqual([]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("message text carrying the bot token is scrubbed from the rendered body", () => {
	const names = { userName: () => undefined, userHandle: () => undefined, channelName: () => undefined };
	const body = renderInboundText(
		{
			type: "message",
			channel: "C1",
			ts: "1.0",
			user: "U1",
			text: `hello ${TOKEN}`,
			files: [],
		} as SlackInboundMessage,
		names,
		TOKEN,
	);
	expect(body).not.toContain(TOKEN);
	expect(body).toContain("[redacted]");
});

test("a display name equal to the bot token cannot re-enter the body after scrubbing", () => {
	const names = { userName: () => TOKEN, userHandle: () => undefined, channelName: () => undefined };
	const body = renderInboundText(
		{
			type: "message",
			channel: "C1",
			ts: "1.0",
			user: "U1",
			text: "<@U1>",
			files: [],
		} as SlackInboundMessage,
		names,
		TOKEN,
	);
	expect(body).toBe("@[redacted]");
	expect(body).not.toContain(TOKEN);
});

test("an inbound localPath is never rendered: only ingest owns that field", async () => {
	const home = await temporaryHome();
	try {
		const hostile = { ...imageFile, localPath: `/tmp/${TOKEN}/leak.png` };
		const enriched = await ingestInboundImages({ files: [hostile] }, { botToken: TOKEN, home, fetcher: fakeFetcher() });
		const body = describeInboundBody(enriched);
		expect(body).toMatch(/inbound-images\/slack-\d+-[0-9a-f]{8}-photo\.png\]$/);
		expect(body).not.toContain("leak.png");
		expect(body).not.toContain(TOKEN);
		// A skipped download renders the url, still without the hostile path.
		const video = await ingestInboundImages(
			{ files: [{ ...hostile, mimetype: "video/mp4" }] },
			{ botToken: TOKEN, home, fetcher: fakeFetcher() },
		);
		expect(describeInboundBody(video)).toBe(`[video · photo.png · 9 B · ${imageFile.url_private}]`);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("malformed metadata types degrade instead of throwing", async () => {
	const home = await temporaryHome();
	try {
		const calls: Calls = { urls: [], authorizations: [] };
		const enriched = await ingestInboundImages(
			{ files: [{ ...imageFile, mimetype: 5 as unknown as string }] },
			{ botToken: TOKEN, home, fetcher: fakeFetcher({}, calls) },
		);
		expect(calls.urls).toEqual([]);
		expect(describeInboundBody(enriched)).toBe(`[file · photo.png · 9 B · ${imageFile.url_private}]`);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("an attachment name carrying the bot token is scrubbed from the body and the saved filename", async () => {
	const home = await temporaryHome();
	try {
		const calls: Calls = { urls: [], authorizations: [] };
		const leaky = { ...imageFile, name: `leak-${TOKEN}.png` };
		const enriched = await ingestInboundImages(
			{ files: [leaky] },
			{ botToken: TOKEN, home, fetcher: fakeFetcher({}, calls) },
		);
		const body = describeInboundBody(enriched);
		expect(body).not.toContain(TOKEN);
		expect(body).toContain("[redacted]");
		for (const name of await readdir(join(home, "inbound-images"))) expect(name).not.toContain(TOKEN);
		// A non-image file never downloads, but its echoed name is still scrubbed.
		const video = await ingestInboundImages(
			{ files: [{ ...leaky, mimetype: "video/mp4" }] },
			{ botToken: TOKEN, home, fetcher: fakeFetcher({}, calls) },
		);
		expect(describeInboundBody(video)).not.toContain(TOKEN);
		expect(calls.urls).toEqual([imageFile.url_private]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a non-Slack host is never downloaded and keeps its url line", async () => {
	const home = await temporaryHome();
	try {
		const calls: Calls = { urls: [], authorizations: [] };
		const enriched = await ingestInboundImages(
			{ files: [{ ...imageFile, url_private: "https://evil.example.com/photo.png" }] },
			{ botToken: TOKEN, home, fetcher: fakeFetcher({}, calls) },
		);
		expect(calls.urls).toEqual([]);
		expect(describeInboundBody(enriched)).toBe("[image · photo.png · 9 B · https://evil.example.com/photo.png]");
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a failed download keeps the url_private line and the message is still rendered", async () => {
	const home = await temporaryHome();
	try {
		const logs: string[] = [];
		const refused = await ingestInboundImages(
			{ files: [imageFile] },
			{
				botToken: TOKEN,
				home,
				fetcher: fakeFetcher({ status: 404 }),
				log: { error: (message) => void logs.push(message) },
			},
		);
		expect(describeInboundBody(refused)).toBe(`[image · photo.png · 9 B · ${imageFile.url_private}]`);
		const thrown = await ingestInboundImages(
			{ files: [imageFile] },
			{
				botToken: TOKEN,
				home,
				fetcher: async () => {
					throw new Error("socket hung up");
				},
			},
		);
		expect(describeInboundBody(thrown)).toBe(`[image · photo.png · 9 B · ${imageFile.url_private}]`);
		expect(logs.join("\n")).not.toContain(TOKEN);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("an oversized image is never fetched; a stream that grows past the limit is cut off", async () => {
	const home = await temporaryHome();
	try {
		const calls: Calls = { urls: [], authorizations: [] };
		const declared = await ingestInboundImages(
			{ files: [{ ...imageFile, size: 100 }] },
			{ botToken: TOKEN, home, limit: 8, fetcher: fakeFetcher({}, calls) },
		);
		expect(calls.urls).toEqual([]);
		expect(describeInboundBody(declared)).toBe(`[image · photo.png · 100 B · ${imageFile.url_private}]`);
		const streamed = await ingestInboundImages(
			{ files: [{ ...imageFile, size: undefined }] },
			{
				botToken: TOKEN,
				home,
				limit: 8,
				fetcher: fakeFetcher({ body: "x".repeat(100) }, calls),
			},
		);
		expect(calls.urls).toEqual([imageFile.url_private]);
		expect(describeInboundBody(streamed)).toBe(`[image · photo.png · ${imageFile.url_private}]`);
		await expect(readdir(join(home, "inbound-images"))).rejects.toThrow();
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("only the rendered first ten attachments are downloaded", async () => {
	const home = await temporaryHome();
	try {
		const calls: Calls = { urls: [], authorizations: [] };
		const files = Array.from({ length: 14 }, (_, index) => ({ ...imageFile, name: `photo-${index}.png` }));
		const enriched = await ingestInboundImages({ files }, { botToken: TOKEN, home, fetcher: fakeFetcher({}, calls) });
		expect(calls.urls).toHaveLength(MAX_INGESTED_FILES);
		expect(calls.urls[0]).toBe(imageFile.url_private);
		const body = describeInboundBody(enriched);
		expect(body.split("\n")).toHaveLength(MAX_INGESTED_FILES + 1);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("non-image files and unrendered carriers are left completely alone", async () => {
	const home = await temporaryHome();
	try {
		const calls: Calls = { urls: [], authorizations: [] };
		const fetcher = fakeFetcher({}, calls);
		const video = await ingestInboundImages(
			{ files: [{ ...imageFile, mimetype: "video/mp4" }] },
			{ botToken: TOKEN, home, fetcher },
		);
		const textless = await ingestInboundImages({ text: "plain" }, { botToken: TOKEN, home, fetcher });
		const empty = await ingestInboundImages({}, { botToken: TOKEN, home, fetcher });
		expect(calls.urls).toEqual([]);
		expect(describeInboundBody(video)).toBe(
			"[video · photo.png · 9 B · https://files.slack.com/files-pri/T1/F1/photo.png]",
		);
		expect(textless).toEqual({ text: "plain" });
		expect(empty).toEqual({});
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
		const old = join(images, "slack-old.png");
		const fresh = join(images, "slack-fresh.png");
		await writeFile(old, "a");
		await writeFile(fresh, "b");
		await utimes(old, new Date(now - 2_000), new Date(now - 2_000));
		await utimes(fresh, new Date(now), new Date(now));
		await pruneInboundImages(images, { now: () => now, maxAgeMs: 1_000 });
		expect(await readdir(images)).toEqual(["slack-fresh.png"]);
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
		const oldest = join(images, "slack-1.png");
		const middle = join(images, "slack-2.png");
		const newest = join(images, "slack-3.png");
		await writeFile(oldest, "x".repeat(10));
		await writeFile(middle, "x".repeat(20));
		await writeFile(newest, "x".repeat(5));
		await utimes(oldest, new Date(now - 30), new Date(now - 30));
		await utimes(middle, new Date(now - 20), new Date(now - 20));
		await utimes(newest, new Date(now - 10), new Date(now - 10));
		await pruneInboundImages(images, { now: () => now, maxTotalBytes: 25 });
		expect([...(await readdir(images))].sort()).toEqual(["slack-2.png", "slack-3.png"]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});
