import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../src/config";
import { BotAudienceTurnGuard } from "../src/engagement/policy";
import { type GatewayServer, startUnixServer } from "../src/server/server";
import { GatewayDatabase } from "../src/store/db";
import { attachTestBrokerOwnership, sessionPortFromScript } from "./session-port.fake";

/**
 * 2026-09-27 lead-bot-ambient: in a `lead` channel a bot's unmentioned
 * top-level post (a sibling persona's `/new` receipt, progress chatter) is
 * ambient room noise. It must never open a trigger turn, never spend the bot
 * turn budget, and still land in the context ledger; the same holds when the
 * bot edits that post. A bot reaches the lead persona only by naming it.
 */

const ORIGIN_REF = { platform: "slack", kind: "channel", conversationId: "C0LEAD" } as const;
const ORIGIN_KEY = "slack/channel/C0LEAD";
/** Mirrors the operating PM config for #oci (engagement lead, audience all, 4-turn bot budget). */
const CHANNEL = { engagement: "lead" as const, audience: "all" as const, botAudienceMaxConsecutiveTurns: 4 };

let directory = "";
let database: GatewayDatabase | undefined;
let server: GatewayServer | undefined;

type TestFrame = {
	readonly id?: string;
	readonly type?: string;
	readonly result?: { readonly turnId?: unknown; readonly engaged?: boolean };
};

async function eventually(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 400; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	expect(predicate(), message).toBe(true);
}

afterEach(async () => {
	await server?.stop();
	server = undefined;
	database?.close();
	database = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = "";
});

async function connect(socketPath: string) {
	const frames: TestFrame[] = [];
	let buffered = "";
	const socket = await Bun.connect({
		unix: socketPath,
		socket: {
			data(_socket, data) {
				buffered += Buffer.from(data).toString();
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) if (line) frames.push(JSON.parse(line) as TestFrame);
			},
		},
	});
	return {
		send: (value: unknown) => socket.write(`${JSON.stringify(value)}\n`),
		frames,
		response: (id: string) => frames.find((frame) => frame.type === "response" && frame.id === id),
		close: () => socket.end(),
	};
}

async function start(respond: (text: string) => Promise<string>) {
	directory = await mkdtemp(join(tmpdir(), "gajaeway-lead-bot-ambient-"));
	const config: GatewayConfig = {
		schemaVersion: 1,
		home: directory,
		configPath: join(directory, "config.json"),
		socketPath: join(directory, "gateway.sock"),
		dbPath: join(directory, "gateway.db"),
		logVerbosity: "info",
		channels: { "slack:C0LEAD": CHANNEL },
	};
	database = await GatewayDatabase.open(config.dbPath);
	const db = database;
	const port = attachTestBrokerOwnership(
		database,
		sessionPortFromScript({
			bind: (key, epoch) => `session-${key}-${epoch}`,
			respond: (_session, text) => respond(text),
		}),
		join(directory, "agent"),
	);
	server = await startUnixServer({ config, database, sessionPort: port, onStop: () => database?.close() });
	const client = await connect(config.socketPath);
	client.send({ v: "0.1", type: "hello", payload: { supportedVersions: ["0.1"] } });
	await eventually(() => client.frames.length >= 1, "negotiation did not complete");
	const chat = (
		id: string,
		verb: "chat.send" | "chat.edit",
		params: { messageId?: string; text: string; authorId: string; authorIsBot: boolean; mentioned: boolean },
	) =>
		client.send({
			v: "0.1",
			type: "request",
			id,
			verb,
			params: {
				origin: ORIGIN_REF,
				text: params.text,
				...(params.messageId ? { messageId: params.messageId } : {}),
				engagement: {
					mentioned: params.mentioned,
					group: true,
					authorId: params.authorId,
					authorName: params.authorId,
					...(params.authorIsBot ? { authorIsBot: true } : {}),
				},
			},
		});
	return { client, port, chat, db };
}

test("a bot's unmentioned top-level post opens no turn, spends no budget, and stays context", async () => {
	const { client, port, chat, db } = await start(async (text) => text);
	// The incident shape: a sibling bot posts "Started a fresh session." at the top level.
	chat("bot-plain", "chat.send", {
		messageId: "C0LEAD:1790471045.435129",
		text: "Started a fresh session.",
		authorId: "BPA",
		authorIsBot: true,
		mentioned: false,
	});
	await eventually(() => client.response("bot-plain") !== undefined, "no response to the bot post");
	expect(client.response("bot-plain")?.result).toEqual({ turnId: null, engaged: false });
	// No trigger turn was created and nothing was dispatched to the session.
	await Bun.sleep(50);
	expect(port.sends).toEqual([]);
	expect(db.inboundNonterminalTurns(ORIGIN_KEY)).toEqual([]);
	expect(db.inboundPendingCount(ORIGIN_KEY)).toBe(0);
	// The post is still unread context for the next engaged turn.
	expect(db.contextWindow(ORIGIN_KEY, "probe").rows.map((row) => row.message_id)).toContain("C0LEAD:1790471045.435129");
	// The bot turn budget was not touched: a bot that names us is admitted on the spot.
	const guard = new BotAudienceTurnGuard(db);
	expect(guard.consecutiveTurns(ORIGIN_KEY)).toBe(0);
	chat("bot-mention", "chat.send", {
		messageId: "C0LEAD:1790471046.000001",
		text: "<@ULEAD> picking this up",
		authorId: "BPA",
		authorIsBot: true,
		mentioned: true,
	});
	await eventually(() => client.response("bot-mention") !== undefined, "no response to the bot mention");
	expect(client.response("bot-mention")?.result?.engaged).toBe(true);
	await eventually(() => port.sends.length === 1, "the mentioned bot turn was not dispatched");
	expect(guard.consecutiveTurns(ORIGIN_KEY)).toBe(1);
	// Settle the fixture turn.
	await eventually(
		() => db.inboundTurnRow(port.sends[0]!.opRef)?.turn_state === "done",
		"fixture bot turn did not settle",
	);
	client.close();
});

test("a bot editing its own unmentioned post opens no turn either", async () => {
	let release!: () => void;
	const running = new Promise<void>((resolve) => {
		release = resolve;
	});
	const { client, port, chat, db } = await start(async () => {
		await running;
		return "ok";
	});
	// A human mention runs the lead's turn.
	chat("human", "chat.send", {
		messageId: "C0LEAD:1790471044.000000",
		text: "<@ULEAD> 상태 어때",
		authorId: "UOWNER",
		authorIsBot: false,
		mentioned: true,
	});
	await eventually(() => port.sends.length === 1, "the human turn was not dispatched");
	// The bot's unmentioned post landed as context only…
	chat("bot-plain", "chat.send", {
		messageId: "C0LEAD:1790471045.435129",
		text: "Started a fresh session.",
		authorId: "BPA",
		authorIsBot: true,
		mentioned: false,
	});
	await eventually(() => client.response("bot-plain")?.result?.engaged === false, "bot post was not declined");
	// …and editing it stays ambient: no steer into the running turn, no next turn.
	chat("bot-edit", "chat.edit", {
		messageId: "C0LEAD:1790471045.435129",
		text: "Started a fresh session. (retrying)",
		authorId: "BPA",
		authorIsBot: true,
		mentioned: false,
	});
	await eventually(() => client.response("bot-edit") !== undefined, "no response to the bot edit");
	expect(client.response("bot-edit")?.result).toEqual({ turnId: null, engaged: false });
	await Bun.sleep(50);
	expect(port.sends).toHaveLength(1);
	expect(port.steers).toEqual([]);
	expect(new BotAudienceTurnGuard(db).consecutiveTurns(ORIGIN_KEY)).toBe(0);
	release();
	await eventually(() => database?.inboundPendingCount(ORIGIN_KEY) === 0, "the human turn did not complete");
	client.close();
});
