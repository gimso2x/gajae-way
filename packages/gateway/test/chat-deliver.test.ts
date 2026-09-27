/**
 * chat.deliver — the direct outbound path (slack_send / slack file send).
 *
 * These tests run the REAL unix server and ledger: a direct send must be
 * prepared durably, fanned out to the platform adapter as a `direct` delivery,
 * and answered only with its SETTLED outcome. A failure the adapter reports is
 * the requester's answer — never a quiet success (acceptance criteria ④⑤).
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../src/config";
import { type GatewayServer, startUnixServer } from "../src/server/server";
import { type BrokerAuthority, GatewayDatabase } from "../src/store/db";
import {
	attachTestBrokerOwnership,
	createOwnedSessionFixture,
	initializeTestBrokerAuthority,
	sessionPortFromResponder,
} from "./session-port.fake";

const SLACK_CHANNEL = { platform: "slack", kind: "channel", conversationId: "C1" } as const;
const SLACK_THREAD = {
	platform: "slack",
	kind: "thread",
	conversationId: "C1:1700000001.000001",
	parentId: "C1",
} as const;

let directory = "";
let server: GatewayServer | undefined;
afterEach(async () => {
	await server?.stop();
	server = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = "";
});

interface Client {
	send(value: unknown): void;
	frames: any[];
	close(): void;
}

async function connect(socketPath: string, clientName?: string): Promise<Client> {
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
	const hello: Record<string, unknown> = { supportedVersions: ["0.1"] };
	if (clientName) hello.clientInfo = { name: clientName, startedAt: new Date().toISOString() };
	socket.write(`${JSON.stringify({ v: "0.1", type: "hello", payload: hello })}\n`);
	return { send: (value) => socket.write(`${JSON.stringify(value)}\n`), frames, close: () => socket.end() };
}

async function waitFor(frames: any[], predicate: (frame: any) => boolean): Promise<any | undefined> {
	for (let attempt = 0; attempt < 200; attempt++) {
		const found = frames.find(predicate);
		if (found) return found;
		await Bun.sleep(5);
	}
	return frames.find(predicate);
}

interface Harness {
	readonly config: GatewayConfig;
	readonly database: GatewayDatabase;
	/** The fake platform adapter, identified the way the real one is. */
	readonly adapter: Client;
	/** A second, unprivileged client (the persona tool side). */
	readonly caller: Client;
	/** Durable ownership, so tests can seed session bindings through the real bind path. */
	readonly authority: BrokerAuthority;
}

async function gateway(options: { deliverSettlementTimeoutMs?: number } = {}): Promise<Harness> {
	directory = await mkdtemp(join(tmpdir(), "gajaeway-chat-deliver-"));
	const config: GatewayConfig = {
		schemaVersion: 1,
		home: directory,
		configPath: join(directory, "config.json"),
		socketPath: join(directory, "gateway.sock"),
		dbPath: join(directory, "gateway.db"),
		logVerbosity: "info",
		channels: { "slack:C1": { engagement: "open" } },
	};
	const database = await GatewayDatabase.open(config.dbPath);
	const sessionPort = sessionPortFromResponder({
		bind: async (originKey, epoch) => `session-${originKey}-${epoch}`,
		respond: async () => "unused",
	});
	attachTestBrokerOwnership(database, sessionPort, join(directory, "agent"));
	const authority = initializeTestBrokerAuthority(database, join(directory, "agent"));
	server = await startUnixServer({
		config,
		database,
		sessionPort,
		onStop: () => database.close(),
		...(options.deliverSettlementTimeoutMs === undefined
			? {}
			: { deliverSettlementTimeoutMs: options.deliverSettlementTimeoutMs }),
	});
	const adapter = await connect(config.socketPath, "adapter-slack");
	await waitFor(adapter.frames, (frame) => frame.type === "negotiated");
	const caller = await connect(config.socketPath);
	await waitFor(caller.frames, (frame) => frame.type === "negotiated");
	return { config, database, adapter, caller, authority };
}

function deliver(client: Client, id: string, params: Record<string, unknown>): void {
	client.send({ v: "0.1", type: "request", id, verb: "chat.deliver", params });
}

/** The fake adapter settles every delivery event it sees with the given outcome. */
function autoSettle(adapter: Client, outcome: "confirm" | "fail", reason = "not_in_channel"): void {
	const handled = new Set<string>();
	const timer = setInterval(() => {
		for (const frame of adapter.frames) {
			if (frame.type !== "event" || frame.event !== "chat.message") continue;
			const deliveryId = frame.payload?.deliveryId;
			if (!deliveryId || handled.has(deliveryId)) continue;
			handled.add(deliveryId);
			adapter.send(
				outcome === "confirm"
					? { v: "0.1", type: "request", id: `confirm-${deliveryId}`, verb: "delivery.confirm", params: { deliveryId } }
					: {
							v: "0.1",
							type: "request",
							id: `fail-${deliveryId}`,
							verb: "delivery.fail",
							params: { deliveryId, reason, ambiguous: false },
						},
			);
		}
	}, 5);
	timer.unref();
}

function responseFor(frames: any[], id: string): any | undefined {
	return frames.find((frame) => frame.type === "response" && frame.id === id);
}

function errorFor(frames: any[], id: string): any | undefined {
	return frames.find((frame) => frame.type === "error" && frame.id === id);
}

test("chat.deliver text settles delivered after the adapter confirms", async () => {
	const h = await gateway();
	autoSettle(h.adapter, "confirm");
	deliver(h.caller, "d1", { origin: SLACK_CHANNEL, text: "#dev-work 결과 보고" });

	const response = await waitFor(h.caller.frames, (frame) => responseFor([frame], "d1"));
	expect(response?.result).toMatchObject({ delivered: true });
	const deliveryId = response?.result?.deliveryId as string;
	expect(deliveryId).toBeString();

	// The adapter saw a DIRECT delivery for the exact origin, with no turn started.
	const event = h.adapter.frames.find(
		(frame) => frame.type === "event" && frame.event === "chat.message" && frame.payload?.deliveryId === deliveryId,
	);
	expect(event?.payload).toMatchObject({
		origin: SLACK_CHANNEL,
		text: "#dev-work 결과 보고",
		direct: true,
		final: true,
	});
	// The ledger row reached its terminal `confirmed` state.
	expect(h.database.deliveryRows().find((row) => row.delivery_id === deliveryId)?.state).toBe("confirmed");
});

test("chat.deliver to a thread origin preserves the thread target", async () => {
	const h = await gateway();
	autoSettle(h.adapter, "confirm");
	deliver(h.caller, "d2", { origin: SLACK_THREAD, text: "스레드 안으로" });
	const response = await waitFor(h.caller.frames, (frame) => responseFor([frame], "d2"));
	expect(response?.result?.delivered).toBe(true);
	const event = h.adapter.frames.find(
		(frame) => frame.type === "event" && frame.event === "chat.message" && frame.payload?.direct === true,
	);
	expect(event?.payload.origin).toEqual(SLACK_THREAD);
});

test("an adapter-reported failure is the settled answer, recorded as failed", async () => {
	const h = await gateway();
	autoSettle(h.adapter, "fail", "not_in_channel");
	deliver(h.caller, "d3", { origin: SLACK_CHANNEL, text: "멤버 아닌 채널로 발신" });

	const response = await waitFor(h.caller.frames, (frame) => responseFor([frame], "d3"));
	expect(response?.result).toMatchObject({
		delivered: false,
		uncertain: false,
		reason: "not_in_channel",
	});
	// The ledger's at-least-once doctrine: a definitive fail is recorded with its
	// attempt count and stays recoverable — it is never rewritten as delivered.
	const row = h.database.deliveryRows().find((row) => row.delivery_id === response?.result?.deliveryId);
	expect(row?.state).toBe("pending");
	expect(row?.attempts).toBe(1);
});

test("a file delivery to the session's own conversation reaches the adapter with the file", async () => {
	const h = await gateway();
	// Bind a session to a slack conversation the way a real persona turn does.
	const file = join(directory, "workspace-report.txt");
	await writeFile(file, "리포트 본문");
	await stat(file);

	const boundSessionId = `session-slack/channel/C1-0`;
	// Seed the binding through the real broker bind path, so the durable
	// ownership rules a production binding obeys are the ones under test.
	await createOwnedSessionFixture(h.database, h.authority, {
		sessionId: boundSessionId,
		originKey: "slack/channel/C1",
		epoch: 0,
		repo: directory,
	});

	autoSettle(h.adapter, "confirm");
	deliver(h.caller, "d4", {
		sessionId: boundSessionId,
		file: { path: file, caption: "요청 결과물" },
	});

	const response = await waitFor(h.caller.frames, (frame) => responseFor([frame], "d4"));
	expect(response?.result?.delivered).toBe(true);
	const event = h.adapter.frames.find(
		(frame) => frame.type === "event" && frame.event === "chat.message" && frame.payload?.direct === true,
	);
	expect(event?.payload.file).toMatchObject({ path: file, caption: "요청 결과물" });
	expect(event?.payload.origin).toEqual(SLACK_CHANNEL);
	expect(event?.payload.text).toBe("요청 결과물");
});

test("a sessionId with no bound conversation is refused, not guessed", async () => {
	const h = await gateway();
	deliver(h.caller, "d5", { sessionId: "no-such-session", text: "hi" });
	const error = await waitFor(h.caller.frames, (frame) => errorFor([frame], "d5"));
	expect(error?.error.code).toBe("invalid_params");
	expect(h.database.deliveryRows()).toHaveLength(0);
});

test("chat.deliver with no adapter for the platform is a definitive no_adapter refusal", async () => {
	// Only a slack adapter is connected here; a telegram target cannot settle.
	const h = await gateway();
	deliver(h.caller, "d6", { origin: { platform: "telegram", kind: "channel", conversationId: "chan-9" }, text: "hi" });
	const error = await waitFor(h.caller.frames, (frame) => errorFor([frame], "d6"));
	expect(error?.error.code).toBe("no_adapter");
	expect(h.database.deliveryRows()).toHaveLength(0);
});

test("params are validated before anything is ledgered", async () => {
	const h = await gateway();
	deliver(h.caller, "d7", { origin: SLACK_CHANNEL, text: "둘 다", file: { path: "/tmp/x" } });
	deliver(h.caller, "d8", { origin: SLACK_CHANNEL });
	deliver(h.caller, "d9", { origin: SLACK_CHANNEL, text: "" });
	deliver(h.caller, "d10", { origin: SLACK_CHANNEL, file: { path: "relative/path.txt" } });
	deliver(h.caller, "d11", { origin: { platform: "monitor", kind: "eventtype", conversationId: "e" }, text: "x" });
	for (const id of ["d7", "d8", "d9", "d10", "d11"]) {
		const error = await waitFor(h.caller.frames, (frame) => errorFor([frame], id));
		expect(error?.error.code).toBe("invalid_params");
	}
	expect(h.database.deliveryRows()).toHaveLength(0);
});

test("a send the adapter never settles reports uncertain and stays recoverable", async () => {
	const h = await gateway({ deliverSettlementTimeoutMs: 80 });
	// The adapter receives the event but never answers.
	deliver(h.caller, "d12", { origin: SLACK_CHANNEL, text: "응답 없는 발신" });
	const response = await waitFor(h.caller.frames, (frame) => responseFor([frame], "d12"));
	expect(response?.result).toMatchObject({ delivered: false, uncertain: true });
	const reason = response?.result?.reason as string | undefined;
	expect(reason).toContain("was not confirmed within");
	// The ledger keeps the row for recovery — it is neither confirmed nor failed.
	const row = h.database.deliveryRows().find((row) => row.delivery_id === response?.result?.deliveryId);
	expect(row?.state).toBe("inflight");
});

test("a silence token is refused instead of being silently dropped", async () => {
	const h = await gateway();
	deliver(h.caller, "d13", { origin: SLACK_CHANNEL, text: "[SILENT]" });
	const error = await waitFor(h.caller.frames, (frame) => errorFor([frame], "d13"));
	expect(error?.error.code).toBe("invalid_params");
	expect(h.database.deliveryRows()).toHaveLength(0);
});
