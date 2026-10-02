import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../src/config";
import type { SessionSendInput } from "../src/orchestrator/session-port";
import { decodeStreamLine } from "../src/orchestrator/tail-runner";
import { type GatewayServer, startUnixServer } from "../src/server/server";
import { GatewayDatabase } from "../src/store/db";
import { attachTestBrokerOwnership, ScriptedSessionPort } from "./session-port.fake";

/**
 * 20261002-suppress-midturn-text: mid-work speech riding a tool call must never
 * reach the channel. Gate-0 evidence (gjc sdk serve --stdio, session
 * 0fba965c-...-0134fc3bf5cc, 2026-10-03): an assistant message_end that calls a
 * tool carries a `toolCall` block (keys type/id/name/arguments) next to its
 * text; the final answer is a text-only message_end.
 *
 * Every assistant frame below is built as a RAW host line and decoded by the
 * production `decodeStreamLine` (via port.emitHostLine) — the flag producer is
 * never bypassed with hand-assembled TailFrames.
 */

const ORIGIN = { platform: "discord", kind: "channel", conversationId: "chan-1" } as const;
const ORIGIN_KEY = "discord/channel/chan-1";
const INTERIM_SUPPRESSED = "Slack에 안 올라가야 할 중간 혼잣말입니다";
const INTERIM_PLAIN = "도구 없는 중간 보고입니다";
const REACTION_INTERIM = "[REACT:👀] 확인 중입니다";
const FINAL = "최종 답변: gate0 실측과 일치합니다";

let directory = "";
let server: GatewayServer | undefined;
afterEach(async () => {
	await server?.stop();
	server = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = "";
});

/** A raw `gjc sdk serve --stdio` stdout line for an assistant message_end. */
function messageEndLine(
	opRef: string,
	messageId: string,
	content: unknown[],
	role: "assistant" | "user" = "assistant",
): string {
	return JSON.stringify({
		type: "event",
		kind: "message_end",
		commandId: `command-${opRef}`,
		turnId: `turn-${opRef}`,
		payload: {
			event_type: "message_end",
			event: { type: "message_end", message: { id: messageId, role, content } },
		},
	});
}

/** Live mid-turn shape (gate-0): speech next to the tool call block. */
function toolCallContent(text: string): unknown[] {
	return [
		{ type: "text", text },
		{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "echo gate0-capture-ok" } },
	];
}

interface Client {
	send(value: unknown): void;
	frames: any[];
	close(): void;
}

async function connect(socketPath: string): Promise<Client> {
	const frames: any[] = [];
	let buffered = "";
	const socket = await Bun.connect({
		unix: socketPath,
		socket: {
			data(_socket, data) {
				buffered += Buffer.from(data).toString();
				const lines = buffered.split("\n");
				buffered = lines.pop() ?? "";
				for (const line of lines) if (line) frames.push(JSON.parse(line));
			},
		},
	});
	return { send: (value) => socket.write(`${JSON.stringify(value)}\n`), frames, close: () => socket.end() };
}

async function eventually(predicate: () => boolean, message: string, attempts = 400): Promise<void> {
	for (let attempt = 0; attempt < attempts; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	expect(predicate(), message).toBe(true);
}

async function withCapturedLog<T>(body: (lines: string[]) => Promise<T>): Promise<T> {
	const lines: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => {
		lines.push(args.map((value) => String(value)).join(" "));
	};
	try {
		return await body(lines);
	} finally {
		console.error = original;
	}
}

async function gateway(
	options: {
		/** Mid-turn: raw frames the "host" streams while the turn is still running. */
		drive?: (port: ScriptedSessionPort, send: SessionSendInput) => Promise<void>;
		/** How the operation settles; defaults to the text-only final answer. */
		settle?: (port: ScriptedSessionPort, send: SessionSendInput) => void;
	} = {},
): Promise<{ client: Client; database: GatewayDatabase; port: ScriptedSessionPort }> {
	directory = await mkdtemp(join(tmpdir(), "gajaeway-interim-suppress-"));
	const config: GatewayConfig = {
		schemaVersion: 1,
		home: directory,
		configPath: join(directory, "config.json"),
		socketPath: join(directory, "gateway.sock"),
		dbPath: join(directory, "gateway.db"),
		logVerbosity: "info",
		channels: { "chan-1": { engagement: "open" } },
	};
	const database = await GatewayDatabase.open(config.dbPath);
	const port = new ScriptedSessionPort({
		onBind: (input) => `session-${input.originKey}-${input.epoch}`,
		onSend: async (input, scripted) => {
			await options.drive?.(scripted, input);
			if (options.settle) {
				options.settle(scripted, input);
			} else {
				scripted.emitHostLine(
					input.sessionId,
					messageEndLine(input.opRef, `final-${input.opRef}`, [{ type: "text", text: FINAL }]),
				);
				scripted.completeWithoutAnswerFrame(input.opRef, FINAL);
			}
		},
	});
	attachTestBrokerOwnership(database, port, join(directory, "agent"));
	server = await startUnixServer({ config, database, sessionPort: port, onStop: () => database.close() });
	const client = await connect(config.socketPath);
	client.send({ v: "0.1", type: "hello", payload: { supportedVersions: ["0.1"] } });
	for (let attempt = 0; attempt < 60 && client.frames.length < 1; attempt++) await Bun.sleep(5);
	return { client, database, port };
}

function sendMessage(client: Client, id: string, text: string, messageId: string): void {
	client.send({
		v: "0.1",
		type: "request",
		id,
		verb: "chat.send",
		params: {
			origin: ORIGIN,
			text,
			messageId,
			engagement: { mentioned: true, group: true, authorId: "human-1", authorName: "형님" },
		},
	});
}

function textEvents(frames: any[]): any[] {
	return frames.filter((frame) => frame.type === "event" && frame.event === "chat.message" && !frame.payload.reaction);
}

function reactionEvents(frames: any[]): any[] {
	return frames.filter((frame) => frame.type === "event" && frame.event === "chat.message" && frame.payload.reaction);
}

test("decodeStreamLine flags toolCall-carrying message_end frames and leaves text-only frames unflagged", () => {
	const [suppressed] = decodeStreamLine(messageEndLine("op-1", "a-1", toolCallContent(INTERIM_SUPPRESSED)));
	expect(suppressed).toMatchObject({
		kind: "message_end",
		assistantText: INTERIM_SUPPRESSED,
		interimSuppressBody: true,
	});
	// Gate-0 shape: the tool call can ride alone, with no text block at all.
	const [toolOnly] = decodeStreamLine(
		messageEndLine("op-1", "a-2", [
			{ type: "toolCall", id: "tc-1", name: "bash", arguments: { command: "echo gate0-capture-ok" } },
		]),
	);
	expect(toolOnly).toMatchObject({ kind: "message_end", interimSuppressBody: true });
	const [plain] = decodeStreamLine(messageEndLine("op-1", "a-3", [{ type: "text", text: INTERIM_PLAIN }]));
	expect(plain).toMatchObject({ kind: "message_end", assistantText: INTERIM_PLAIN });
	expect("interimSuppressBody" in plain).toBe(false);
	// A user row is attribution evidence, never assistant speech to suppress.
	const [echo] = decodeStreamLine(messageEndLine("op-1", "u-1", [{ type: "text", text: "steer echo" }], "user"));
	expect(echo).toMatchObject({ kind: "message_end", steerEcho: true });
	expect("interimSuppressBody" in echo).toBe(false);
});

test("scenario (i): a toolCall-carrying message_end delivers no interim body and logs exactly one suppression", async () => {
	await withCapturedLog(async (lines) => {
		const { client } = await gateway({
			drive: async (port, send) => {
				port.emitHostLine(send.sessionId, messageEndLine(send.opRef, "a-1", toolCallContent(INTERIM_SUPPRESSED)));
			},
		});
		sendMessage(client, "c1", "이거 고쳐줘", "m-sup-1");
		await eventually(
			() => textEvents(client.frames).some((frame) => frame.payload.text === FINAL),
			"terminal never posted",
		);
		// The turn's only channel text is the terminal answer; the suppressed body never shipped.
		expect(textEvents(client.frames).map((frame) => frame.payload.text)).toEqual([FINAL]);
		const suppressions = lines.filter((line) => line.includes("gateway_interim_suppressed"));
		expect(suppressions).toHaveLength(1);
		expect(suppressions[0]).toContain(`origin=${ORIGIN_KEY}`);
		expect(suppressions[0]).toMatch(/turnId=\S+/);
		expect(suppressions[0]).toContain("toolCall=true");
		expect(suppressions[0]).toContain(`body=${INTERIM_SUPPRESSED}`);
	});
});

test("scenario (ii): a text-only message_end still delivers its interim body exactly once", async () => {
	const { client } = await gateway({
		drive: async (port, send) => {
			port.emitHostLine(send.sessionId, messageEndLine(send.opRef, "a-1", [{ type: "text", text: INTERIM_PLAIN }]));
		},
	});
	sendMessage(client, "c1", "상황 알려줘", "m-sup-2");
	await eventually(
		() => textEvents(client.frames).some((frame) => frame.payload.text === INTERIM_PLAIN),
		"plain interim was not delivered",
	);
	await eventually(
		() => textEvents(client.frames).some((frame) => frame.payload.text === FINAL),
		"terminal never posted",
	);
	expect(textEvents(client.frames).map((frame) => frame.payload.text)).toEqual([INTERIM_PLAIN, FINAL]);
});

test("scenario (iii): the same turn's terminal answer posts exactly once although mid-turn speech was suppressed", async () => {
	const { client, database } = await gateway({
		drive: async (port, send) => {
			port.emitHostLine(send.sessionId, messageEndLine(send.opRef, "a-1", toolCallContent(INTERIM_SUPPRESSED)));
			// The tail also ships the finalized answer before agent_end, as live turns do.
			port.emitHostLine(send.sessionId, messageEndLine(send.opRef, "a-2", [{ type: "text", text: FINAL }]));
		},
	});
	sendMessage(client, "c1", "디버그 결과 요약해줘", "m-sup-3");
	await eventually(
		() => textEvents(client.frames).some((frame) => frame.payload.text === FINAL),
		"terminal never posted",
	);
	expect(textEvents(client.frames).map((frame) => frame.payload.text)).toEqual([FINAL]);
	const rows = database.deliveryRows().filter((row) => row.origin_key === ORIGIN_KEY);
	expect(rows).toHaveLength(1);
});

test("scenario (iv): a suppressed interim still claims its [REACT:] exactly once while the body stays dropped", async () => {
	const { client } = await gateway({
		drive: async (port, send) => {
			port.emitHostLine(send.sessionId, messageEndLine(send.opRef, "a-1", toolCallContent(REACTION_INTERIM)));
		},
	});
	sendMessage(client, "c1", "슬랙 반응부터 달아줘", "m-sup-4");
	await eventually(() => reactionEvents(client.frames).length === 1, "reaction was never claimed");
	expect(reactionEvents(client.frames)).toHaveLength(1);
	expect(reactionEvents(client.frames)[0].payload.reaction.emoji).toBe("👀");
	expect(reactionEvents(client.frames)[0].payload.reaction.targetMessageId).toBe("m-sup-4");
	await eventually(
		() => textEvents(client.frames).some((frame) => frame.payload.text === FINAL),
		"terminal never posted",
	);
	// The body next to the token never ships; the reaction is the only mid-turn output.
	expect(textEvents(client.frames).map((frame) => frame.payload.text)).toEqual([FINAL]);
});

test("a suppress-only frame keeps the steer window open: no visible delivery, onFrame false", async () => {
	let release!: () => void;
	const hold = new Promise<void>((resolve) => {
		release = resolve;
	});
	const { client, port } = await gateway({
		drive: async (scripted, send) => {
			scripted.emitHostLine(send.sessionId, messageEndLine(send.opRef, "a-1", toolCallContent(INTERIM_SUPPRESSED)));
			await hold;
		},
	});
	sendMessage(client, "c1", "첫 번째 요청", "m-sup-5");
	await eventually(() => port.sends.length === 1, "turn was not dispatched");
	await eventually(
		() => port.tailFrames(port.sends[0]!.sessionId).length > 0,
		"suppressed frame never reached the tail",
	);
	// assistantDeliveryStarted is still false: the suppressed body shipped nothing.
	expect(textEvents(client.frames)).toHaveLength(0);
	// The follow-up therefore steers into the RUNNING turn (steer window stayed open).
	sendMessage(client, "c2", "진행 어떻게 되고 있어?", "m-sup-6");
	await eventually(() => port.steers.length === 1, "suppress-only frame closed the steer window");
	expect(port.sends).toHaveLength(1);
	release();
	await eventually(
		() => textEvents(client.frames).some((frame) => frame.payload.text === FINAL),
		"terminal never posted",
	);
	expect(textEvents(client.frames).map((frame) => frame.payload.text)).toEqual([FINAL]);
});

test("a failing turn whose only speech was suppressed posts exactly one [turn failed] notice", async () => {
	await withCapturedLog(async (lines) => {
		const { client } = await gateway({
			drive: async (port, send) => {
				port.emitHostLine(send.sessionId, messageEndLine(send.opRef, "a-1", toolCallContent(INTERIM_SUPPRESSED)));
			},
			settle: (port, send) =>
				port.fail(send.opRef, "Agent run failed after execution started.", { code: "prompt_failed" }),
		});
		sendMessage(client, "c1", "배포 돌려줘", "m-sup-7");
		await eventually(() => textEvents(client.frames).length === 1, "failure notice did not go out");
		const notices = textEvents(client.frames);
		expect(notices[0].payload.text).toContain("[turn failed]");
		expect(notices[0].payload.text).toContain("prompt_failed");
		// The suppressed speech is the turn's only mid-work output; it shipped nothing but the notice.
		expect(lines.filter((line) => line.includes("gateway_interim_suppressed"))).toHaveLength(1);
		expect(lines.some((line) => line.includes(INTERIM_SUPPRESSED) && line.includes("chat"))).toBe(false);
	});
});
