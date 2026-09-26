import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatMessagePayload, OriginRef } from "@gajae-gateway/protocol";
import { loadTelegramAdapterConfig, TelegramAdapterStartupError } from "../src/config";
import { TelegramImageIngest } from "../src/ingest";
import {
	chunkTelegramMessage,
	engagementForMessage,
	type GatewayClientLike,
	settleTelegramDelivery,
	subscribeTelegramDeliveries,
	TelegramAdapter,
	TelegramBotApi,
	type TelegramUpdate,
} from "../src/main";
import { telegramMessageOrigin } from "../src/origin";
import { TelegramAdapterState } from "../src/state";

const topicMessage = {
	message_id: 7,
	chat: { id: -100123, type: "supergroup" },
	from: { id: 42 },
	message_thread_id: 99,
	is_topic_message: true,
	text: "hello @agent",
};

test("loads a token exclusively from its configured credential file", async () => {
	const home = await temporaryHome();
	try {
		await writeFile(join(home, "token"), " test-token \n");
		await writeFile(
			join(home, "adapter-telegram.json"),
			JSON.stringify({ tokenFile: "token", chats: { "1": { engagement: "open" } } }),
		);
		const config = await loadTelegramAdapterConfig({ GAJAEWAY_HOME: home });
		expect(config.token).toBe("test-token");
		expect(config.tokenFile).toBe(join(home, "token"));
		await writeFile(join(home, "adapter-telegram.json"), "{}");
		await expect(loadTelegramAdapterConfig({ GAJAEWAY_HOME: home })).rejects.toBeInstanceOf(
			TelegramAdapterStartupError,
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("maps private chats, groups, and forum topics to isolated origins", () => {
	expect(telegramMessageOrigin({ chat: { id: 10, type: "private" }, from: { id: 11 } })).toEqual({
		platform: "telegram",
		kind: "dm",
		conversationId: "10",
		peerId: "11",
	});
	expect(telegramMessageOrigin({ chat: { id: -20, type: "group" }, from: { id: 11 } })).toEqual({
		platform: "telegram",
		kind: "channel",
		conversationId: "-20",
	});
	expect(telegramMessageOrigin(topicMessage)).toEqual({
		platform: "telegram",
		kind: "topic",
		conversationId: "-100123.99",
		parentId: "-100123",
	});
});

test("persists a forum topic route across restart and sends replies to its topic", async () => {
	const home = await temporaryHome();
	try {
		const state = await TelegramAdapterState.load(home);
		const origin = telegramMessageOrigin(topicMessage);
		await state.rememberOrigin(origin, 99);
		const restarted = await TelegramAdapterState.load(home);
		const sent: Array<{ chatId: string; text: string; thread?: number }> = [];
		const requests: Array<{ verb: string; params: unknown }> = [];
		await settleTelegramDelivery(
			mockGateway(requests),
			{ sendMessage: async (chatId, text, thread) => void sent.push({ chatId, text, thread }) },
			restarted,
			delivery(origin, "reply"),
		);
		expect(sent).toEqual([{ chatId: "-100123", text: "reply", thread: 99 }]);
		expect(requests).toEqual([{ verb: "delivery.confirm", params: { deliveryId: "delivery-1" } }]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("deduplicates update ids durably before sending an inbound turn", async () => {
	const home = await temporaryHome();
	try {
		const state = await TelegramAdapterState.load(home);
		const adapter = new TelegramAdapter(state, "agent", "900", { chats: {} }, stubIngest());
		const requests: Array<{ verb: string; params: unknown }> = [];
		const gateway = mockGateway(requests);
		const update: TelegramUpdate = { update_id: 81, message: topicMessage };
		expect(await adapter.handleUpdate(gateway, update)).toBe(true);
		expect(await adapter.handleUpdate(gateway, update)).toBe(false);
		expect(requests).toHaveLength(1);
		const restarted = new TelegramAdapter(
			await TelegramAdapterState.load(home),
			"agent",
			"900",
			{ chats: {} },
			stubIngest(),
		);
		expect(await restarted.handleUpdate(gateway, update)).toBe(false);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.params).toEqual({
			origin: { platform: "telegram", kind: "topic", conversationId: "-100123.99", parentId: "-100123" },
			text: "hello @agent",
			engagement: { mentioned: true, group: true, authorId: "42" },
		});
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("mention matching stays case-insensitive across text and caption", () => {
	const origin: OriginRef = { platform: "telegram", kind: "channel", conversationId: "-100123" };
	const message = (extra: Record<string, unknown>) => ({
		message_id: 11,
		chat: { id: -100123, type: "supergroup" },
		from: { id: 42 },
		...extra,
	});
	expect(engagementForMessage(message({ text: "LOOK @AGENT" }), origin, "agent", "900").mentioned).toBe(true);
	expect(
		engagementForMessage(
			message({ caption: "look @AGENT", photo: [{ file_id: "p", width: 1, height: 1 }] }),
			origin,
			"agent",
			"900",
		).mentioned,
	).toBe(true);
	expect(engagementForMessage(message({ caption: "just chatting" }), origin, "agent", "900").mentioned).toBe(false);
});

test("a photo is a turn even without text, with caption-based engagement", async () => {
	const home = await temporaryHome();
	try {
		const state = await TelegramAdapterState.load(home);
		const adapter = new TelegramAdapter(state, "agent", "900", { chats: {} }, stubIngest());
		const requests: Array<{ verb: string; params: unknown }> = [];
		const gateway = mockGateway(requests);
		const photo = {
			message_id: 8,
			chat: { id: -100123, type: "supergroup" },
			from: { id: 42 },
			photo: [{ file_id: "large", width: 100, height: 100 }],
			caption: "look @agent",
		};
		expect(await adapter.handleUpdate(gateway, { update_id: 82, message: photo })).toBe(true);
		expect(requests).toHaveLength(1);
		expect(requests[0]?.verb).toBe("chat.send");
		expect(requests[0]?.params).toMatchObject({
			origin: { platform: "telegram", kind: "channel", conversationId: "-100123" },
			engagement: { mentioned: true, group: true, authorId: "42" },
		});
		expect(String((requests[0]?.params as { text: string }).text)).toBe("look @agent\n[image · photo.jpg · image]");
		// A captionless photo is still a turn.
		expect(
			await adapter.handleUpdate(gateway, {
				update_id: 83,
				message: { ...photo, message_id: 9, caption: undefined },
			}),
		).toBe(true);
		expect(requests).toHaveLength(2);
		// A textless non-image document keeps its existing behavior: no turn.
		expect(
			await adapter.handleUpdate(gateway, {
				update_id: 84,
				message: {
					...photo,
					message_id: 10,
					caption: undefined,
					photo: undefined,
					document: { file_id: "d", mime_type: "application/pdf" },
				},
			}),
		).toBe(true);
		expect(requests).toHaveLength(2);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("chunks at Telegram's 4096 character API limit", () => {
	expect(chunkTelegramMessage("x".repeat(8_193)).map((chunk) => chunk.length)).toEqual([4_096, 4_096, 1]);
});

test("prefixes recovered delivery and settles via injected fake fetch", async () => {
	const home = await temporaryHome();
	try {
		const state = await TelegramAdapterState.load(home);
		const origin = telegramMessageOrigin({ chat: { id: 22, type: "private" }, from: { id: 44 } });
		await state.rememberOrigin(origin);
		const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
		const bot = new TelegramBotApi("not-a-real-token", async (url, init) => {
			calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
			return Response.json({ ok: true, result: { message_id: 1 } });
		});
		const requests: Array<{ verb: string; params: unknown }> = [];
		await settleTelegramDelivery(mockGateway(requests), bot, state, {
			...delivery(origin, "x".repeat(4_090)),
			duplicateWarning: true,
		});
		expect(calls.map((call) => String(call.body.text).length)).toEqual([4_096, 27]);
		expect(calls[0]?.body.text).toBe(`[recovered - may be a duplicate] ${"x".repeat(4_090)}`.slice(0, 4_096));
		expect(requests).toEqual([{ verb: "delivery.confirm", params: { deliveryId: "delivery-1" } }]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("fails delivery ambiguously when transport times out after dispatch", async () => {
	const home = await temporaryHome();
	try {
		const state = await TelegramAdapterState.load(home);
		const origin = telegramMessageOrigin({ chat: { id: 22, type: "private" }, from: { id: 44 } });
		await state.rememberOrigin(origin);
		const requests: Array<{ verb: string; params: unknown }> = [];
		await settleTelegramDelivery(
			mockGateway(requests),
			{ sendMessage: async () => Promise.reject(new Error("timeout after dispatch")) },
			state,
			delivery(origin, "reply"),
		);
		expect(requests).toEqual([
			{
				verb: "delivery.fail",
				params: { deliveryId: "delivery-1", reason: "timeout after dispatch", ambiguous: true },
			},
		]);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

// The delivery subscription is the merge seam: it chooses between the reaction
// path and the text path. Deleting that choice leaves every other test green
// while a reaction gets POSTED as the bare emoji, which is exactly the outcome
// the reported-failure policy exists to prevent.
test("the delivery subscription routes a reaction to setMessageReaction and never to sendMessage", async () => {
	const home = await temporaryHome();
	try {
		const state = await TelegramAdapterState.load(home);
		const origin = telegramMessageOrigin({ chat: { id: 22, type: "private" }, from: { id: 44 } });
		await state.rememberOrigin(origin);
		const requests: Array<{ verb: string; params: unknown }> = [];
		const sent: string[] = [];
		const reacted: Array<{ chatId: string; messageId: string; emoji: string }> = [];
		let handler: ((message: ChatMessagePayload) => void) | undefined;
		const gateway: GatewayClientLike = {
			request: async <T>(verb: string, params?: unknown) => {
				requests.push({ verb, params });
				return {} as T;
			},
			onChatMessage: (given) => {
				handler = given;
				return () => {};
			},
		};
		subscribeTelegramDeliveries(
			gateway,
			{
				sendMessage: async (_chatId, text) => void sent.push(text),
				setMessageReaction: async (chatId, messageId, emoji) => void reacted.push({ chatId, messageId, emoji }),
			},
			state,
		);
		handler?.({
			...delivery(origin, "👍"),
			reaction: { targetMessageId: "77", emoji: "👍", emojiName: "thumbsup" },
		});
		for (let attempt = 0; attempt < 20 && requests.length === 0; attempt++) await Bun.sleep(5);
		expect(reacted).toEqual([{ chatId: "22", messageId: "77", emoji: "👍" }]);
		expect(sent).toEqual([]);
		expect(requests).toEqual([{ verb: "delivery.confirm", params: { deliveryId: "delivery-1" } }]);
		// The same subscription still delivers ordinary text through sendMessage.
		requests.length = 0;
		handler?.(delivery(origin, "안녕하세요"));
		for (let attempt = 0; attempt < 20 && requests.length === 0; attempt++) await Bun.sleep(5);
		expect(sent).toEqual(["안녕하세요"]);
		expect(reacted).toHaveLength(1);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

async function temporaryHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "gajaeway-telegram-adapter-"));
}
/**
 * An ingest whose downloads always fail (Telegram returns no file path): exercises
 * the unpathed fallback line without any network, the way a real outage would.
 */
function stubIngest(): TelegramImageIngest {
	return new TelegramImageIngest(
		{
			token: "stub-token",
			fetcher: async () => {
				throw new Error("test must not fetch files");
			},
			getFile: async () => ({}),
		},
		"/tmp/gajaeway-telegram-stub",
	);
}

function delivery(origin: ChatMessagePayload["origin"], text: string): ChatMessagePayload {
	return { turnId: "turn-1", origin, role: "assistant", text, final: true, deliveryId: "delivery-1" };
}

function mockGateway(requests: Array<{ verb: string; params: unknown }>): GatewayClientLike {
	return {
		request: async <T>(verb: string, params?: unknown) => {
			requests.push({ verb, params });
			return {} as T;
		},
		onChatMessage: () => () => {},
	};
}
