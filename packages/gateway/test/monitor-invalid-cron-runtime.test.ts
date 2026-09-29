import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryService } from "../src/delivery/delivery";
import { MonitorPropagator } from "../src/monitors/propagate";
import { MonitorRegistry } from "../src/monitors/registry";
import { MonitorRuntime } from "../src/monitors/runtime";
import { startUnixServer } from "../src/server/server";
import { GatewayDatabase } from "../src/store/db";
import { DeliveryLedger } from "../src/store/ledger";
import { sessionPortFromScript } from "./session-port.fake";

let home = "";
let database: GatewayDatabase | undefined;
let propagators: MonitorPropagator[] = [];
afterEach(async () => {
	for (const propagator of propagators) await propagator.drain();
	propagators = [];
	database?.close();
	database = undefined;
	if (home) await rm(home, { recursive: true, force: true });
	home = "";
});

function eventsFromPrompt(text: string): Array<{ eventId: string }> {
	const match = text.match(/\[.*\]$/s);
	if (!match) throw new Error("prompt has no event array");
	return JSON.parse(match[0]) as Array<{ eventId: string }>;
}

function propagator(registry: MonitorRegistry): MonitorPropagator {
	const value = new MonitorPropagator({
		database: database!,
		registry,
		sessionPort: sessionPortFromScript({
			bind: async () => ({ sessionId: "s" }),
			respond: async (_id, text) =>
				JSON.stringify(eventsFromPrompt(text).map(({ eventId: id }) => ({ eventId: id, note: "n" }))),
		}),
		memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
		delivery: new DeliveryService(new DeliveryLedger(database!)),
		emit: () => {},
	});
	propagators.push(value);
	return value;
}

function openHome(): Promise<string> {
	return mkdtemp(join(tmpdir(), "gajaeway-invalid-cron-"));
}

test("a bad persisted cron monitor is skipped with one structured line while good cron monitors keep firing", async () => {
	home = await openHome();
	database = await GatewayDatabase.open(join(home, "gateway.db"));
	const registry = new MonitorRegistry(database);
	const good = registry.add({
		name: "good-cron",
		trigger: { kind: "cron", schedule: "30 6 * * *" },
		eventTypes: ["memory.canonicalize"],
		burstPolicy: "dedupe",
		enabled: true,
	});
	const bad = registry.add({
		name: "bad-cron",
		trigger: { kind: "cron", schedule: "bogus" },
		eventTypes: ["memory.canonicalize"],
		enabled: true,
	});
	// The due 06:30 slot precedes the monitor's creation timestamp; the catch-up
	// cursor clamps to createdAt, so backdate it to the same day: exactly one
	// slot (06:30) lies between the cursor and now.
	database.monitorSetCreatedAt(good.monitorId, new Date(2026, 0, 5, 0, 0).toISOString());
	const logs: string[] = [];
	const originalError = console.error;
	console.error = (line: unknown) => logs.push(String(line));
	let runtime: MonitorRuntime | undefined;
	try {
		runtime = new MonitorRuntime(
			{
				schemaVersion: 1,
				home,
				configPath: join(home, "config.json"),
				socketPath: join(home, "gateway.sock"),
				dbPath: join(home, "gateway.db"),
				logVerbosity: "info",
			},
			registry,
			propagator(registry),
			database,
			{ now: () => new Date(2026, 0, 5, 6, 30) },
		);
		// ① startup and ② the refresh() after monitor.add/remove must both resolve.
		await runtime.start();
		await runtime.refresh();
	} finally {
		console.error = originalError;
		runtime?.stop();
	}
	// One structured skip line per start()/refresh() pass (two passes here),
	// each naming only the bad monitor.
	const skips = logs.filter((line) => line.includes("monitor_trigger_invalid"));
	expect(skips).toHaveLength(2);
	expect(skips[0]).toBe(skips[1]);
	expect(skips[0]).toContain(`monitorId=${bad.monitorId}`);
	expect(skips[0]).toContain('name="bad-cron"');
	expect(skips[0]).toContain('schedule="bogus"');
	expect(skips[0]).toContain("reason=field_count");
	// The good monitor still fired its due 06:30 slot into the durable queue.
	const rows = database.monitorEventRows().filter((row) => row.monitor_id === good.monitorId);
	expect(rows).toHaveLength(1);
	expect(JSON.parse(rows[0]!.payload_json)).toEqual({ at: new Date(2026, 0, 5, 6, 30).toISOString() });
	expect(database.monitorEventRows().some((row) => row.monitor_id === bad.monitorId)).toBe(false);
});

test("monitor.add rejects an invalid cron schedule with invalid_params before it reaches the registry", async () => {
	home = await openHome();
	database = await GatewayDatabase.open(join(home, "gateway.db"));
	// A bad cron monitor persisted BEFORE boot: the server must start with it
	// (path ①), and both `void refresh()` callsites after monitor.add/remove
	// (path ②) must not turn it into an unhandled rejection.
	const bad = new MonitorRegistry(database).add({
		name: "bad-cron",
		trigger: { kind: "cron", schedule: "bogus" },
		eventTypes: ["memory.canonicalize"],
		enabled: true,
	});
	const sessionPort = sessionPortFromScript({
		bind: async () => ({ sessionId: "s" }),
		respond: async () => "[]",
	});
	const socketPath = join(home, "gateway.sock");
	const server = await startUnixServer({
		config: {
			schemaVersion: 1,
			home,
			configPath: join(home, "config.json"),
			socketPath,
			dbPath: join(home, "gateway.db"),
			logVerbosity: "info",
		},
		database,
		sessionPort,
		onStop: () => {},
	});
	let socket: Awaited<ReturnType<typeof Bun.connect>> | undefined;
	try {
		const frames: Array<Record<string, unknown>> = [];
		let buffered = "";
		socket = await Bun.connect({
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
		const add = (id: string, verb: string, params: Record<string, unknown>) => {
			socket!.write(`${JSON.stringify({ v: "0.1", type: "request", id, verb, params })}\n`);
		};
		const frameFor = async (id: string): Promise<Record<string, unknown>> => {
			for (let attempt = 0; attempt < 400; attempt++) {
				const frame = frames.find((entry) => entry.id === id);
				if (frame) return frame;
				await Bun.sleep(5);
			}
			throw new Error(`no monitor.add response for ${id}`);
		};
		socket.write(`${JSON.stringify({ v: "0.1", type: "hello", payload: { supportedVersions: ["0.1"] } })}\n`);
		for (const schedule of ["bogus", "* * * *", "99 * * * *", "*/0 * * * *"]) {
			add(`bad-${schedule}`, "monitor.add", {
				name: `bad-${schedule}`,
				trigger: { kind: "cron", schedule },
				eventTypes: ["memory.canonicalize"],
			});
		}
		for (const schedule of ["bogus", "* * * *", "99 * * * *", "*/0 * * * *"]) {
			const frame = await frameFor(`bad-${schedule}`);
			expect(frame.type).toBe("error");
			expect((frame.error as { code: string }).code).toBe("invalid_params");
		}
		add("good", "monitor.add", {
			name: "good-cron",
			trigger: { kind: "cron", schedule: "0 6 * * *" },
			eventTypes: ["memory.canonicalize"],
		});
		const goodFrame = await frameFor("good");
		expect(goodFrame.type).toBe("response");
		const persisted = new MonitorRegistry(database).list();
		expect(persisted.map((monitor) => monitor.name).sort()).toEqual(["bad-cron", "good-cron"]);
		// The registry stamps the gateway's local timezone onto a cron trigger.
		expect(persisted.find((monitor) => monitor.name === "good-cron")!.trigger).toMatchObject({
			kind: "cron",
			schedule: "0 6 * * *",
			timezone: expect.any(String),
		});
		// monitor.remove drives the second `void refresh()` callsite with the bad
		// monitor still persisted; neither refresh may reject.
		add("remove", "monitor.remove", { monitorId: (goodFrame.result as { monitorId: string }).monitorId });
		const removeFrame = await frameFor("remove");
		expect(removeFrame.type).toBe("response");
		const afterRemoval = new MonitorRegistry(database).list();
		expect(afterRemoval.map((monitor) => monitor.name)).toEqual(["bad-cron"]);
		expect(afterRemoval[0]!.monitorId).toBe(bad.monitorId);
	} finally {
		await server.stop();
		socket?.end();
	}
});
test("a bad cron monitor never gets an interval while the good monitor keeps firing across ticks", async () => {
	home = await openHome();
	database = await GatewayDatabase.open(join(home, "gateway.db"));
	const registry = new MonitorRegistry(database);
	const good = registry.add({
		name: "good-cron",
		trigger: { kind: "cron", schedule: "* * * * *" },
		eventTypes: ["memory.canonicalize"],
		enabled: true,
	});
	const bad = registry.add({
		name: "bad-cron",
		trigger: { kind: "cron", schedule: "bogus" },
		eventTypes: ["memory.canonicalize"],
		enabled: true,
	});
	database.monitorSetCreatedAt(good.monitorId, new Date(2026, 0, 1, 0, 0).toISOString());
	const logs: string[] = [];
	const originalError = console.error;
	console.error = (line: unknown) => logs.push(String(line));
	let runtime: MonitorRuntime | undefined;
	try {
		let step = 0;
		const base = new Date(2026, 0, 5, 6, 30);
		runtime = new MonitorRuntime(
			{
				schemaVersion: 1,
				home,
				configPath: join(home, "config.json"),
				socketPath: join(home, "gateway.sock"),
				dbPath: join(home, "gateway.db"),
				logVerbosity: "info",
			},
			registry,
			propagator(registry),
			database,
			{ now: () => new Date(base.getTime() + step++ * 60_000), cronIntervalMs: 5 },
		);
		await runtime.start();
		await runtime.refresh();
		await Bun.sleep(30);
	} finally {
		console.error = originalError;
		runtime?.stop();
	}
	// The bad monitor has no interval timer of its own: the skip line appears
	// exactly once per start()/refresh() pass, never per tick, and it admits
	// nothing.
	const skips = logs.filter((line) => line.includes("monitor_trigger_invalid"));
	expect(skips).toHaveLength(2);
	expect(skips[0]).toContain(`monitorId=${bad.monitorId}`);
	expect(skips[0]).toContain("reason=field_count");
	expect(database.monitorEventRows().some((row) => row.monitor_id === bad.monitorId)).toBe(false);
	// The good monitor kept firing: the bounded catch-up batch plus later ticks.
	const rows = database.monitorEventRows().filter((row) => row.monitor_id === good.monitorId);
	expect(rows.length).toBeGreaterThanOrEqual(9);
});
