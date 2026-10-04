import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	BROKER_HEARTBEAT_TTL_MS,
	type BrokerLivenessVerdict,
	describeBindHold,
	GlobalGjcClient,
	judgeBrokerLiveness,
} from "../src/orchestrator/broker";
import { BIND_WEDGE_PROBE_STRIKES, PersonaSessionManager } from "../src/orchestrator/persona-session";
import { BrokerSessionPort, type SessionBindInput } from "../src/orchestrator/session-port";
import { TailRunner } from "../src/orchestrator/tail-runner";
import { GatewayDatabase } from "../src/store/db";
import { initializeTestBrokerAuthority, noRelay, ScriptedSessionPort } from "./session-port.fake";

const NOW = Date.parse("2026-09-18T00:00:00.000Z");
const REPO = "/tmp/gajaeway-broker-wedge-repo";
const ORIGIN = "discord/channel/broker-wedge";

const directories: string[] = [];
const databases: GatewayDatabase[] = [];

afterEach(async () => {
	for (const database of databases.splice(0)) database.close();
	await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function discovery(pid: number, heartbeatAt: number): Record<string, unknown> {
	return {
		protocolVersion: 3,
		host: "127.0.0.1",
		url: "ws://127.0.0.1:43123",
		token: "test-token",
		pid,
		heartbeatAt,
	};
}

async function discoveryFile(home: string, body: unknown): Promise<string> {
	const path = join(home, "sdk", "broker.json");
	await mkdir(join(home, "sdk"), { recursive: true });
	await writeFile(path, JSON.stringify(body));
	return path;
}

async function eventually(predicate: () => boolean, message: string, attempts = 200): Promise<void> {
	for (let index = 0; index < attempts; index++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	expect(predicate(), message).toBe(true);
}

test("broker discovery liveness distinguishes dead owners, fresh owners, stale heartbeats, and absence", async () => {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-broker-wedge-liveness-"));
	directories.push(home);
	const missing = join(home, "missing", "broker.json");
	expect(await judgeBrokerLiveness(missing, () => true, NOW)).toEqual({ state: "absent" });

	const corrupt = join(home, "corrupt.json");
	await writeFile(corrupt, "not-json");
	expect(await judgeBrokerLiveness(corrupt, () => true, NOW)).toEqual({ state: "absent" });

	const deadPath = await discoveryFile(home, discovery(7001, NOW));
	expect(await judgeBrokerLiveness(deadPath, () => false, NOW)).toEqual({
		state: "wedged",
		reason: "pid_dead",
		pid: 7001,
		heartbeatAt: NOW,
	});

	const stalePath = await discoveryFile(home, discovery(7002, NOW - BROKER_HEARTBEAT_TTL_MS - 1));
	expect(await judgeBrokerLiveness(stalePath, () => true, NOW)).toEqual({
		state: "wedged",
		reason: "heartbeat_stale",
		pid: 7002,
		heartbeatAt: NOW - BROKER_HEARTBEAT_TTL_MS - 1,
	});

	const livePath = await discoveryFile(home, discovery(7003, NOW));
	expect(await judgeBrokerLiveness(livePath, () => true, NOW)).toEqual({
		state: "live",
		pid: 7003,
		heartbeatAt: NOW,
	});
});

test("the broker supervisor exposes a discovery-file liveness seam with an injected pid probe", async () => {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-broker-wedge-supervisor-"));
	directories.push(home);
	const agentDir = join(home, "agent");
	const now = Date.now();
	const discoveryPath = await discoveryFile(agentDir, discovery(8123, now));
	const broker = new GlobalGjcClient({
		executable: "/fake/gjc",
		agentDir,
		cwd: home,
		isPidAlive: (pid) => pid === 8123,
	});
	// realpath: macOS resolves the temp dir through /private, so the raw strings differ.
	expect(await realpath(broker.discoveryPath)).toBe(await realpath(discoveryPath));
	expect(await broker.judgeLiveness()).toEqual({ state: "live", pid: 8123, heartbeatAt: now });
	await writeFile(discoveryPath, JSON.stringify(discovery(8123, now - BROKER_HEARTBEAT_TTL_MS - 1)));
	expect(await broker.judgeLiveness()).toMatchObject({ state: "wedged", reason: "heartbeat_stale" });
});

test("bind hold descriptions identify the wedge cause instead of reporting a bare prompt failure", () => {
	const verdict: BrokerLivenessVerdict = {
		state: "wedged",
		reason: "pid_dead",
		pid: 9123,
		heartbeatAt: Date.parse("2026-09-17T21:30:00.000Z"),
	};
	const hold = describeBindHold(verdict, "gjc sdk request failed: unavailable", BIND_WEDGE_PROBE_STRIKES);
	expect(hold.reason).toBe("broker_wedged");
	expect(hold.notice).toContain("sdk unavailable / broker wedged since 2026-09-17T21:30:00.000Z");
	expect(hold.notice).toContain("pid 9123 is dead");
	expect(hold.notice).not.toContain("Prompt submission failed");
});

test("repeated uncertain creates preserve one epoch and deterministic key without a rotation counter", async () => {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-broker-wedge-rotation-"));
	directories.push(home);
	const database = await GatewayDatabase.open(join(home, "gateway.db"));
	databases.push(database);
	const authority = initializeTestBrokerAuthority(database, join(home, "agent"));
	const keys: string[] = [];
	const run = async (args: readonly string[]) => {
		if (args.includes("session.create")) {
			keys.push(args[args.indexOf("--idempotency-key") + 1]!);
			return {
				exitCode: 1,
				stdout: JSON.stringify({ ok: false, error: { code: "terminal_uncertain", message: "startup pending" } }),
				stderr: "",
			};
		}
		throw new Error(`unexpected command: ${args.join(" ")}`);
	};
	const port = new BrokerSessionPort({
		database,
		authority,
		cli: run,
		instanceId: "broker-wedge-rotation",
		tailRunner: new TailRunner({ stream: noRelay, repo: REPO }),
		sleep: async () => {},
	});
	const epoch = database.bumpEpoch(ORIGIN, "{}");
	for (let attempt = 0; attempt < 4; attempt++) {
		await expect(port.bind({ originKey: ORIGIN, epoch, repo: REPO })).rejects.toThrow("terminal_uncertain");
		expect(database.getSessionRecord(ORIGIN)).toMatchObject({ epoch, sessionId: "" });
	}
	expect(keys).toHaveLength(20);
	expect(new Set(keys).size).toBe(1);
	expect(database.metaGet(`create_rotation:${ORIGIN}`)).toBeUndefined();
});

test("create recovery and resume retain the original epoch and binding", async () => {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-broker-wedge-reset-"));
	directories.push(home);
	const database = await GatewayDatabase.open(join(home, "gateway.db"));
	databases.push(database);
	const authority = initializeTestBrokerAuthority(database, join(home, "agent"));
	let fail = true;
	let live = true;
	const keys: string[] = [];
	const run = async (args: readonly string[]) => {
		if (args.includes("session.create")) {
			keys.push(args[args.indexOf("--idempotency-key") + 1]!);
			return fail
				? {
						exitCode: 1,
						stdout: JSON.stringify({ ok: false, error: { code: "terminal_uncertain", message: "startup pending" } }),
						stderr: "",
					}
				: { exitCode: 0, stdout: JSON.stringify({ ok: true, result: { sessionId: "recovered" } }), stderr: "" };
		}
		if (args.includes("session.resume")) {
			live = true;
			return { exitCode: 0, stdout: JSON.stringify({ ok: true, result: {} }), stderr: "" };
		}
		if (args.includes("session.list"))
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					ok: true,
					result: { savedSession: { id: "recovered", path: "/saved/recovered.jsonl" } },
				}),
				stderr: "",
			};
		if (args.includes("inspect"))
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					ok: true,
					result: { session: { sessionId: "recovered", live, deleted: false, locator: { cwd: REPO } } },
				}),
				stderr: "",
			};
		throw new Error(`unexpected command: ${args.join(" ")}`);
	};
	const port = new BrokerSessionPort({
		database,
		authority,
		cli: run,
		instanceId: "broker-wedge-reset",
		tailRunner: new TailRunner({ stream: noRelay, repo: REPO }),
		sleep: async () => {},
	});
	await expect(port.bind({ originKey: ORIGIN, epoch: 0, repo: REPO })).rejects.toThrow();
	fail = false;
	await expect(port.bind({ originKey: ORIGIN, epoch: 0, repo: REPO })).resolves.toMatchObject({
		sessionId: "recovered",
		epoch: 0,
	});
	expect(new Set(keys).size).toBe(1);
	live = false;
	await expect(port.resume({ sessionId: "recovered", repo: REPO, originKey: ORIGIN, epoch: 0 })).resolves.toMatchObject(
		{ sessionId: "recovered" },
	);
	expect(database.getSessionRecord(ORIGIN)).toMatchObject({ sessionId: "recovered", epoch: 0 });
	expect(database.metaGet(`create_rotation:${ORIGIN}`)).toBeUndefined();
});

class FailingBindPort extends ScriptedSessionPort {
	bindAttempts = 0;
	failure = true;

	override async bind(input: SessionBindInput) {
		this.bindAttempts += 1;
		if (this.failure) throw new Error("gjc sdk request failed: broker unavailable");
		return await super.bind(input);
	}
}

test("persona holds a pending trigger with the broker wedge cause after five identical bind failures", async () => {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-broker-wedge-persona-"));
	directories.push(home);
	const database = await GatewayDatabase.open(join(home, "gateway.db"));
	databases.push(database);
	const port = new FailingBindPort({ onSend: (input, scripted) => scripted.complete(input.opRef, "recovered") });
	const timers: Array<{ readonly work: () => void; readonly delayMs: number }> = [];
	const holds: string[] = [];
	let probes = 0;
	const manager = new PersonaSessionManager({
		database,
		port,
		instanceId: "broker-wedge-persona",
		repo: REPO,
		setTimeout: (work, delayMs) => {
			const timer = { work, delayMs };
			timers.push(timer);
			return timer;
		},
		clearTimeout: () => {},
		brokerLiveness: async () => {
			probes += 1;
			return {
				state: "wedged",
				reason: "heartbeat_stale",
				pid: 999,
				heartbeatAt: NOW - BROKER_HEARTBEAT_TTL_MS - 1,
			};
		},
		onBindHold: ({ notice }) => {
			holds.push(notice);
		},
		log: () => {},
	});
	database.inboundEnqueue({
		messageId: "m-broker-wedge",
		originKey: ORIGIN,
		originRefJson: JSON.stringify({ platform: "discord", kind: "channel", conversationId: "broker-wedge" }),
		body: "hello",
		receivedAt: new Date(NOW).toISOString(),
	});
	try {
		await manager.notifyInbound(ORIGIN);
		await eventually(() => port.bindAttempts === 1, "first bind did not run");
		for (let index = 1; index < BIND_WEDGE_PROBE_STRIKES; index++) {
			timers.at(-1)?.work();
			await eventually(() => port.bindAttempts === index + 1, `bind ${index + 1} did not run`);
		}
		expect(probes).toBe(1);
		expect(holds).toHaveLength(1);
		expect(holds[0]).toContain("sdk unavailable / broker wedged since");
		expect(holds[0]).toContain("stopped heartbeating");
		expect(holds[0]).not.toContain("Prompt submission failed");
	} finally {
		await manager.stop();
	}
});
