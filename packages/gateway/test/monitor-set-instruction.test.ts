import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MonitorRecord } from "@gajae-gateway/protocol";
import type { GatewayConfig } from "../src/config";
import { type GatewayServer, startUnixServer } from "../src/server/server";
import { GatewayDatabase } from "../src/store/db";
import { sessionPortFromResponder } from "./session-port.fake";

let directory = "";
let server: GatewayServer | undefined;
let database: GatewayDatabase | undefined;
afterEach(async () => {
	await server?.stop();
	server = undefined;
	database?.close();
	database = undefined;
	if (directory) await rm(directory, { recursive: true, force: true });
	directory = "";
});

async function startServer(): Promise<{
	send: (value: unknown) => void;
	frames: Array<Record<string, unknown>>;
	close: () => void;
	db: GatewayDatabase;
	monitor: MonitorRecord;
	slotAt: string;
}> {
	directory = await mkdtemp(join(tmpdir(), "gajaeway-set-instruction-"));
	const config: GatewayConfig = {
		schemaVersion: 1,
		home: directory,
		configPath: join(directory, "config.json"),
		socketPath: join(directory, "gateway.sock"),
		dbPath: join(directory, "gateway.db"),
		logVerbosity: "info",
	};
	const db = await GatewayDatabase.open(config.dbPath);
	database = db;
	const sessionPort = sessionPortFromResponder({ respond: async () => "mock reply" });
	server = await startUnixServer({ config, database: db, sessionPort, onStop: () => db.close() });
	const client = await connect(config.socketPath);
	const registry = (await import("../src/monitors/registry")).MonitorRegistry;
	const monitors = new registry(db);
	const monitor = monitors.add({
		name: "nightly-canonicalize",
		trigger: { kind: "cron", schedule: "30 6 * * *" },
		eventTypes: ["memory.canonicalize"],
		instruction: "이전 지시문",
	});
	// A fired cron slot: the ledger keyed by monitor id must survive any
	// instruction edit — a re-created monitor would open the slot again.
	const slotAt = "2026-09-28T06:30:00.000Z";
	db.monitorSlotClaimWithEvent({
		monitorId: monitor.monitorId,
		slotAt,
		eventId: crypto.randomUUID(),
		eventType: "memory.canonicalize",
		payloadJson: "{}",
	});
	return { ...client, db, monitor, slotAt };
}

async function connect(socketPath: string) {
	const frames: Array<Record<string, unknown>> = [];
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
	return {
		send: (value: unknown) => socket.write(`${JSON.stringify(value)}\n`),
		frames,
		close: () => socket.end(),
	};
}

async function response(frames: Array<Record<string, unknown>>, id: string): Promise<Record<string, unknown>> {
	for (let attempt = 0; attempt < 400; attempt++) {
		const frame = frames.find((f) => f.id === id);
		if (frame) return frame;
		await Bun.sleep(5);
	}
	throw new Error(`no frame for ${id}`);
}

test("monitor.setInstruction rewrites ONLY the instruction and reflects immediately on the same server", async () => {
	const ctx = await startServer();
	ctx.send({ v: "0.1", type: "hello", payload: { supportedVersions: ["0.1"] } });
	await response(ctx.frames, "__negotiated__").catch(() => undefined);
	const before = ctx.monitor;
	ctx.send({
		v: "0.1",
		type: "request",
		id: "set",
		verb: "monitor.setInstruction",
		params: { monitorId: before.monitorId, instruction: "가장 오래된 항목 하나만 세 줄로 요약한다" },
	});
	const res = await response(ctx.frames, "set");
	expect(res.type).toBe("response");
	const monitor = (res.result as { monitor: MonitorRecord }).monitor;
	// The new instruction landed.
	expect(monitor.instruction).toBe("가장 오래된 항목 하나만 세 줄로 요약한다");
	// Identity untouched: id, trigger, event types, created_at.
	expect(monitor.monitorId).toBe(before.monitorId);
	expect(monitor.trigger).toEqual(before.trigger);
	expect(monitor.eventTypes).toEqual(before.eventTypes);
	expect(monitor.createdAt).toBe(before.createdAt);
	// The cron slot ledger (keyed by monitor id) is untouched — no new slots.
	expect(ctx.db.monitorSlotExists(before.monitorId, ctx.slotAt)).toBe(true);
	// Same server, immediate reflection: registry.get() re-reads the store.
	ctx.send({
		v: "0.1",
		type: "request",
		id: "inspect",
		verb: "monitor.inspect",
		params: { monitorId: before.monitorId },
	});
	const inspected = await response(ctx.frames, "inspect");
	expect((inspected.result as { monitor: MonitorRecord }).monitor.instruction).toBe(
		"가장 오래된 항목 하나만 세 줄로 요약한다",
	);
});

test("monitor.setInstruction null clears the instruction (the --clear path)", async () => {
	const ctx = await startServer();
	ctx.send({ v: "0.1", type: "hello", payload: { supportedVersions: ["0.1"] } });
	await response(ctx.frames, "__negotiated__").catch(() => undefined);
	ctx.send({
		v: "0.1",
		type: "request",
		id: "clear",
		verb: "monitor.setInstruction",
		params: { monitorId: ctx.monitor.monitorId, instruction: null },
	});
	const res = await response(ctx.frames, "clear");
	expect(res.type).toBe("response");
	const monitor = (res.result as { monitor: MonitorRecord }).monitor;
	// Cleared: no instruction key at all (null normalises away).
	expect(monitor.instruction).toBeUndefined();
	expect(monitor.monitorId).toBe(ctx.monitor.monitorId);
	expect(monitor.createdAt).toBe(ctx.monitor.createdAt);
	expect(ctx.db.monitorSlotExists(ctx.monitor.monitorId, ctx.slotAt)).toBe(true);
	// A whitespace-only rewrite normalises to cleared, exactly like monitor.add.
	ctx.send({
		v: "0.1",
		type: "request",
		id: "blank",
		verb: "monitor.setInstruction",
		params: { monitorId: ctx.monitor.monitorId, instruction: "   " },
	});
	const blank = await response(ctx.frames, "blank");
	expect((blank.result as { monitor: MonitorRecord }).monitor.instruction).toBeUndefined();
});

test("monitor.setInstruction rejects an unknown id and an over-long instruction, leaving the monitor untouched", async () => {
	const ctx = await startServer();
	ctx.send({ v: "0.1", type: "hello", payload: { supportedVersions: ["0.1"] } });
	await response(ctx.frames, "__negotiated__").catch(() => undefined);
	// Unknown id is an error, not a silent no-op.
	ctx.send({
		v: "0.1",
		type: "request",
		id: "unknown",
		verb: "monitor.setInstruction",
		params: { monitorId: "no-such-monitor", instruction: "x" },
	});
	const unknown = await response(ctx.frames, "unknown");
	expect(unknown.type).toBe("error");
	expect((unknown as { error: { code: string; message?: string } }).error.code).toBe("invalid_params");
	expect((unknown as { error: { message?: string } }).error.message).toContain("unknown monitor");
	// Over the 4000-character cap is an error.
	ctx.send({
		v: "0.1",
		type: "request",
		id: "toolong",
		verb: "monitor.setInstruction",
		params: { monitorId: ctx.monitor.monitorId, instruction: "x".repeat(4001) },
	});
	const toolong = await response(ctx.frames, "toolong");
	expect(toolong.type).toBe("error");
	expect((toolong as { error: { message?: string } }).error.message).toContain("at most 4000 characters");
	// Both failures left the original instruction and identity in place.
	ctx.send({
		v: "0.1",
		type: "request",
		id: "inspect-after",
		verb: "monitor.inspect",
		params: { monitorId: ctx.monitor.monitorId },
	});
	const inspected = await response(ctx.frames, "inspect-after");
	const monitor = (inspected.result as { monitor: MonitorRecord }).monitor;
	expect(monitor.instruction).toBe("이전 지시문");
	expect(monitor.createdAt).toBe(ctx.monitor.createdAt);
	expect(ctx.db.monitorSlotExists(ctx.monitor.monitorId, ctx.slotAt)).toBe(true);
});
