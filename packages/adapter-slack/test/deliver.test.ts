import { expect, test } from "bun:test";
import type { ChatMessagePayload } from "@gajae-gateway/protocol";
import { SLACK_FILE_MAX_BYTES, SlackApiError, SlackWebApi } from "../src/api";
import { assertBotMembership, settleSlackDelivery } from "../src/main";

/** The completion call of an upload flow, looked up by method so ordering with the membership probe stays irrelevant. */
function completeCall(calls: RecordedCall[]): RecordedCall | undefined {
	return calls.find((call) => call.url.endsWith("files.completeUploadExternal"));
}
const CHANNEL_ORIGIN = { platform: "slack", kind: "channel", conversationId: "C1" } as const;
const THREAD_ORIGIN = {
	platform: "slack",
	kind: "thread",
	conversationId: "C1:1700000001.000001",
	parentId: "C1",
} as const;

function decodeJsonBody(headers: Headers, raw: string): Record<string, unknown> {
	if (headers.get("content-type") === "application/x-www-form-urlencoded") {
		const decoded: Record<string, unknown> = {};
		for (const [key, value] of new URLSearchParams(raw)) decoded[key] = value;
		return decoded;
	}
	return JSON.parse(raw);
}

interface RecordedCall {
	readonly url: string;
	readonly method?: string;
	readonly headers: Headers;
	readonly body: unknown;
}

function fixture() {
	const calls: RecordedCall[] = [];
	let responder: (url: string) => Response = () =>
		Response.json({ ok: true, upload_url: "https://files.slack.com/upload/v1/default", file_id: "F1" });
	const api = new SlackWebApi("xoxb-secret", {
		fetcher: async (input, init) => {
			const url = String(input);
			const headers = new Headers(init?.headers);
			let body: unknown = init?.body;
			if (typeof body === "string") body = decodeJsonBody(headers, body);
			calls.push({ url, method: init?.method, headers, body });
			return responder(url);
		},
	});
	return {
		api,
		calls,
		respond: (next: (url: string) => Response) => {
			responder = next;
		},
	};
}

/** A gateway double that records confirm/fail reports the way settleSlackDelivery makes them. */
function gatewayDouble() {
	const reports: Array<{ verb: string; params: unknown }> = [];
	return {
		reports,
		request: async <T = unknown>(verb: string, params?: unknown): Promise<T> => {
			reports.push({ verb, params });
			return (verb === "delivery.confirm" ? { settled: true } : { recorded: true }) as T;
		},
	};
}

test("uploadFile runs the filesUploadV2 flow: URL grant, raw bytes, completion", async () => {
	const f = fixture();
	const UPLOAD_URL = "https://files.slack.com/upload/v1/abc123";
	f.respond((url) =>
		url === UPLOAD_URL
			? new Response("OK", { status: 200 })
			: Response.json({ ok: true, upload_url: UPLOAD_URL, file_id: "F1" }),
	);
	const bytes = new Uint8Array([1, 2, 3, 4]);
	const { fileId } = await f.api.uploadFile({
		channel: "C1",
		threadTs: "1700000001.000001",
		fileName: "report.png",
		caption: "금주 리포트",
		bytes,
		mimeType: "image/png",
	});
	expect(fileId).toBe("F1");
	expect(f.calls).toHaveLength(3);
	// Step 1: presigned URL grant (a Web API write, JSON-encoded, bearer-authenticated).
	expect(f.calls[0]?.url).toBe("https://slack.com/api/files.getUploadURLExternal");
	expect(f.calls[0]?.body).toMatchObject({ filename: "report.png", length: 4 });
	expect(f.calls[0]?.body).not.toHaveProperty("alt_txt");
	expect(f.calls[0]?.headers.get("authorization")).toBe("Bearer xoxb-secret");
	// Step 2: the bytes go to the presigned URL with NO bot token attached.
	expect(f.calls[1]?.url).toBe(UPLOAD_URL);
	expect(f.calls[1]?.method).toBe("POST");
	expect(f.calls[1]?.headers.get("authorization")).toBeNull();
	expect(f.calls[1]?.headers.get("content-type")).toBe("image/png");
	expect(f.calls[1]?.body).toBeInstanceOf(Uint8Array);
	expect(Array.from(f.calls[1]?.body as Uint8Array)).toEqual([1, 2, 3, 4]);
	// Step 3: completion places the file with thread routing and the caption.
	expect(f.calls[2]?.url).toBe("https://slack.com/api/files.completeUploadExternal");
	expect(f.calls[2]?.body).toMatchObject({
		files: [{ id: "F1", title: "report.png" }],
		channel_id: "C1",
		thread_ts: "1700000001.000001",
		initial_comment: "금주 리포트",
	});
});

test("uploadFile omits thread and caption when the target is a top-level channel", async () => {
	const f = fixture();
	await f.api.uploadFile({ channel: "C1", fileName: "a.txt", bytes: new Uint8Array([65]) });
	expect(f.calls[2]?.url).toBe("https://slack.com/api/files.completeUploadExternal");
	const body = f.calls[2]?.body as Record<string, unknown>;
	expect(body.channel_id).toBe("C1");
	expect(body).not.toHaveProperty("thread_ts");
	expect(body).not.toHaveProperty("initial_comment");
});

test("uploadFile refuses oversized files before any request", async () => {
	const f = fixture();
	const error = await f.api
		.uploadFile({ channel: "C1", fileName: "big.bin", bytes: new Uint8Array(SLACK_FILE_MAX_BYTES + 1) })
		.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(SlackApiError);
	expect((error as SlackApiError).code).toBe("file_too_large");
	expect(f.calls).toHaveLength(0);
});

test("a Web API refusal inside the upload flow is a definitive SlackApiError", async () => {
	const f = fixture();
	f.respond(() => Response.json({ ok: false, error: "not_allowed" }));
	const error = await f.api
		.uploadFile({ channel: "C1", fileName: "a.txt", bytes: new Uint8Array([65]) })
		.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(SlackApiError);
	expect((error as SlackApiError).code).toBe("not_allowed");
	expect(f.calls).toHaveLength(1);
});

test("a failed byte upload is definitive, not silent", async () => {
	const f = fixture();
	const UPLOAD_URL = "https://files.slack.com/upload/v1/abc123";
	f.respond((url) =>
		url === UPLOAD_URL
			? new Response("forbidden", { status: 403 })
			: Response.json({ ok: true, upload_url: UPLOAD_URL, file_id: "F1" }),
	);
	const error = await f.api
		.uploadFile({ channel: "C1", fileName: "a.txt", bytes: new Uint8Array([65]) })
		.catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(SlackApiError);
	expect((error as SlackApiError).code).toBe("http_403");
	expect(f.calls).toHaveLength(2);
});

test("assertBotMembership rejects only affirmative non-membership, before any write", async () => {
	const f = fixture();
	f.respond((url) =>
		url.endsWith("conversations.info")
			? Response.json({ ok: true, channel: { id: "C1", is_member: false } })
			: Response.json({ ok: true }),
	);
	const error = await assertBotMembership(f.api, "C1", "channel").catch((caught: unknown) => caught);
	expect(error).toBeInstanceOf(SlackApiError);
	expect((error as SlackApiError).code).toBe("not_in_channel");
	// The rejection is a read, never a message: exactly one conversations.info call.
	expect(f.calls).toHaveLength(1);
	expect(f.calls[0]?.url).toBe("https://slack.com/api/conversations.info");

	// Unknown membership (field absent) never false-rejects.
	f.respond((url) =>
		url.endsWith("conversations.info")
			? Response.json({ ok: true, channel: { id: "C1" } })
			: Response.json({ ok: true }),
	);
	await assertBotMembership(f.api, "C1", "channel");

	// Affirmative membership passes.
	f.respond((url) =>
		url.endsWith("conversations.info")
			? Response.json({ ok: true, channel: { id: "C1", is_member: true } })
			: Response.json({ ok: true }),
	);
	await assertBotMembership(f.api, "C1", "channel");

	// DMs are always the bot's own: no probe at all.
	const before = f.calls.length;
	await assertBotMembership(f.api, "D1", "dm");
	expect(f.calls).toHaveLength(before);
});

function fileDelivery(overrides: Partial<ChatMessagePayload> = {}): ChatMessagePayload {
	return {
		turnId: "turn-1",
		origin: CHANNEL_ORIGIN,
		role: "assistant",
		text: "",
		final: true,
		deliveryId: "d-file-1",
		direct: true,
		file: { path: "/tmp/report.png", caption: "리포트" },
		...overrides,
	};
}

test("a file delivery uploads to its thread and is confirmed", async () => {
	const f = fixture();
	const UPLOAD_URL = "https://files.slack.com/upload/v1/x";
	f.respond((url) => {
		if (url === UPLOAD_URL) return new Response("OK", { status: 200 });
		if (url.endsWith("conversations.info")) return Response.json({ ok: true, channel: { id: "C1", is_member: true } });
		return Response.json({ ok: true, upload_url: UPLOAD_URL, file_id: "F9" });
	});
	const gateway = gatewayDouble();
	// A real file on disk: settlement reads the bytes at delivery time.
	const tmp = `/tmp/slack-deliver-${crypto.randomUUID()}.png`;
	await Bun.write(tmp, "pngbytes");
	try {
		await settleSlackDelivery(gateway, f.api, fileDelivery({ file: { path: tmp, caption: "리포트" } }));
	} finally {
		await Bun.$`rm -f ${tmp}`.quiet();
	}
	// Thread routing comes from the origin, exactly as a text reply would route.
	const upload = completeCall(f.calls)?.body as Record<string, unknown>;
	expect(completeCall(f.calls)?.url).toBe("https://slack.com/api/files.completeUploadExternal");
	expect(upload.channel_id).toBe("C1");
	expect(upload.initial_comment).toBe("리포트");
	expect(gateway.reports.map((r) => r.verb)).toEqual(["delivery.confirm"]);
	// The presigned byte upload carries no bot token.
	const byteUpload = f.calls.find((call) => call.url.startsWith("https://files.slack.com/upload/"));
	expect(byteUpload?.headers.get("authorization")).toBeNull();
});

test("a thread file delivery routes inside the thread", async () => {
	const f = fixture();
	const UPLOAD_URL = "https://files.slack.com/upload/v1/t";
	f.respond((url) => {
		if (url === UPLOAD_URL) return new Response("OK", { status: 200 });
		if (url.endsWith("conversations.info")) return Response.json({ ok: true, channel: { id: "C1", is_member: true } });
		return Response.json({ ok: true, upload_url: UPLOAD_URL, file_id: "F9" });
	});
	const gateway = gatewayDouble();
	const tmp = `/tmp/slack-deliver-${crypto.randomUUID()}.txt`;
	await Bun.write(tmp, "text");
	try {
		await settleSlackDelivery(gateway, f.api, fileDelivery({ origin: THREAD_ORIGIN, file: { path: tmp } }));
	} finally {
		await Bun.$`rm -f ${tmp}`.quiet();
	}
	const upload = completeCall(f.calls)?.body as Record<string, unknown>;
	expect(upload.thread_ts).toBe("1700000001.000001");
	expect(upload.channel_id).toBe("C1");
	expect(upload).not.toHaveProperty("initial_comment");
	expect(gateway.reports).toHaveLength(1);
});

test("an upload failure after the post is recorded, never confirmed", async () => {
	const f = fixture();
	const UPLOAD_URL = "https://files.slack.com/upload/v1/y";
	f.respond((url) => {
		if (url === UPLOAD_URL) return new Response("OK", { status: 200 });
		if (url.endsWith("files.completeUploadExternal")) return Response.json({ ok: false, error: "internal_error" });
		if (url.endsWith("conversations.info")) return Response.json({ ok: true, channel: { id: "C1", is_member: true } });
		return Response.json({ ok: true, upload_url: UPLOAD_URL, file_id: "F9" });
	});
	const gateway = gatewayDouble();
	const tmp = `/tmp/slack-deliver-${crypto.randomUUID()}.txt`;
	await Bun.write(tmp, "text");
	try {
		await settleSlackDelivery(gateway, f.api, fileDelivery({ text: "See attached", file: { path: tmp } }));
	} finally {
		await Bun.$`rm -f ${tmp}`.quiet();
	}
	expect(gateway.reports.map((r) => r.verb)).toEqual(["delivery.fail"]);
	expect(f.calls.map((call) => call.url)).toContain("https://slack.com/api/chat.postMessage");
	expect(completeCall(f.calls)).toBeDefined();
	const fail = gateway.reports[0]?.params as { ambiguous: boolean; reason: string };
	expect(fail.ambiguous).toBe(false);
	expect(fail.reason).toContain("internal_error");
});

test("a file missing at settlement time fails definitively without any Slack call", async () => {
	const f = fixture();
	const gateway = gatewayDouble();
	await settleSlackDelivery(gateway, f.api, fileDelivery({ file: { path: "/nonexistent/file.bin" } }));
	expect(f.calls).toHaveLength(0);
	expect(gateway.reports.map((r) => r.verb)).toEqual(["delivery.fail"]);
	const fail = gateway.reports[0]?.params as { ambiguous: boolean; reason: string };
	expect(fail.ambiguous).toBe(false);
	expect(fail.reason).toContain("/nonexistent/file.bin");
});

test("a direct text send to a channel the bot is not in is refused before posting", async () => {
	const f = fixture();
	f.respond((url) =>
		url.endsWith("conversations.info")
			? Response.json({ ok: true, channel: { id: "C9", is_member: false } })
			: Response.json({ ok: true }),
	);
	const gateway = gatewayDouble();
	await settleSlackDelivery(
		gateway,
		f.api,
		fileDelivery({
			origin: { platform: "slack", kind: "channel", conversationId: "C9" },
			file: undefined,
			text: "보내면 안 되는 메시지",
		}),
	);
	// Only the membership probe ran; no chat.postMessage, and the outcome is a
	// definitive failure — a quiet success here would be a silent lost message.
	expect(f.calls).toHaveLength(1);
	expect(gateway.reports.map((r) => r.verb)).toEqual(["delivery.fail"]);
	const fail = gateway.reports[0]?.params as { ambiguous: boolean; reason: string };
	expect(fail.ambiguous).toBe(false);
	expect(fail.reason).toContain("not a member of C9");
});

test("a conversation reply never pays the membership probe", async () => {
	const f = fixture();
	const gateway = gatewayDouble();
	await settleSlackDelivery(gateway, f.api, fileDelivery({ file: undefined, text: "평소 회신", direct: undefined }));
	expect(f.calls.map((c) => c.url)).toEqual(["https://slack.com/api/chat.postMessage"]);
	expect(gateway.reports.map((r) => r.verb)).toEqual(["delivery.confirm"]);
});
