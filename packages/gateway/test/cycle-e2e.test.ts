import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OriginRef } from "@gajae-gateway/protocol";
import { appendAttempt, closeAttempt, createLaneJobRecord } from "@gajae-gateway/subsession";
import type { GatewayConfig } from "../src/config";
import { RuntimeCycleProjector } from "../src/ops/cycle";
import { type GatewayServer, startUnixServer } from "../src/server/server";
import { GatewayDatabase, type WorkAttemptRuntime, workAttemptDeliveryId } from "../src/store/db";
import { DeliveryLedger } from "../src/store/ledger";
import { sessionPortFromResponder } from "./session-port.fake";

let directory = "";
let server: GatewayServer | undefined;

afterEach(async () => {
	await server?.stop("test teardown");
	server = undefined;
});

const discordDm: OriginRef = { platform: "discord", kind: "dm", conversationId: "c1", peerId: "p1" };

function testConfig(dir: string): GatewayConfig {
	return {
		schemaVersion: 1,
		home: dir,
		configPath: join(dir, "config.json"),
		socketPath: join(dir, "gateway.sock"),
		dbPath: join(dir, "gateway.db"),
		logVerbosity: "info",
	};
}

test("projector reads durable rows through the database and stays fail-closed", async () => {
	directory = await mkdtemp(join(tmpdir(), "gajaeway-cycle-db-"));
	const database = await GatewayDatabase.open(join(directory, "gateway.db"));
	try {
		const key = "discord/dm/c1/peer=p1";
		// Mid-rebind state: /new bumped the epoch and cleared the session binding.
		database.bumpEpoch(key, JSON.stringify(discordDm));
		const projector = new RuntimeCycleProjector(database, { queueDepth: 0 });
		const afterBump = projector.project();
		expect(afterBump.gates).toEqual([]);
		expect(afterBump.phase).toBe("idle");
		expect(afterBump.sessions[0]).toMatchObject({ originKey: key, epoch: 1, sessionId: "" });
		database.inboundEnqueue({
			messageId: "waiting-bind",
			originKey: key,
			originRefJson: JSON.stringify(discordDm),
			body: "bind next",
		});
		expect(projector.project().gates).toContain("stale_session_identity");
		expect(projector.project().phase).toBe("degraded");
		database.inboundBindTurn({
			messageId: "waiting-bind",
			originKey: key,
			epoch: 1,
			opRef: "gw-p-waiting-bind",
			sessionId: "s1",
		});
		database.inboundTurnComplete("gw-p-waiting-bind");

		// A bound session clears the stale-identity gate.
		database.putSession(key, "sess-bound-000000000");
		const bound = new RuntimeCycleProjector(database, { queueDepth: 0 }).project();
		expect(bound.gates).toEqual([]);
		expect(bound.phase).toBe("idle");
		expect(bound.instanceId).toBeString();

		// A durable pending inbound message projects dispatching and attaches to its origin.
		database.inboundEnqueue({
			messageId: "m1",
			originKey: key,
			originRefJson: JSON.stringify(discordDm),
			body: "hello",
		});
		const dispatching = new RuntimeCycleProjector(database, { queueDepth: 0 }).project();
		expect(dispatching.phase).toBe("dispatching");
		expect(dispatching.sessions[0].pendingInbound).toBe(1);

		// Binding it as a turn keeps it dispatching; terminal completion returns to idle.
		database.inboundBindTurn({ messageId: "m1", originKey: key, epoch: 0, opRef: "gw-p-m1", sessionId: "s1" });
		const boundCycle = new RuntimeCycleProjector(database, { queueDepth: 0 }).project();
		expect(boundCycle.phase).toBe("dispatching");
		expect(database.inboundTurnComplete("gw-p-m1")).toBe(1);
		expect(new RuntimeCycleProjector(database, { queueDepth: 0 }).project().phase).toBe("idle");

		// A quarantined memory intent is a gate, not silence.
		database.memoryIntentCreate({ id: "mi1", kind: "daily_capture", payloadJson: "{}" });
		database.memoryIntentUpdate("mi1", "quarantined");
		const gated = new RuntimeCycleProjector(database, { queueDepth: 0 }).project();
		expect(gated.gates).toContain("memory_closure_blocked");
		expect(gated.phase).toBe("degraded");

		// Real-DB age regression (architect blocker): a seconds-vs-ms precedence bug in
		// the census SQL once returned ~-1.8e12 here. The age must be a plausible ms value.
		const ledger = new DeliveryLedger(database);
		const created = Date.now();
		ledger.createPending({
			deliveryId: "age-check",
			turnId: "t-age",
			originKey: key,
			payloadJson: JSON.stringify({ turnId: "t-age", origin: discordDm, role: "assistant", text: "x", final: true }),
		});
		await Bun.sleep(1100);
		const aged = new RuntimeCycleProjector(database, { queueDepth: 0 }).project();
		const age = aged.sessions[0].oldestUnsettledAgeMs;
		expect(age).toBeNumber();
		expect(age as number).toBeGreaterThanOrEqual(1000);
		expect(age as number).toBeLessThan(Date.now() - created + 5_000);
		expect(aged.deliveries.pending).toBe(1);
	} finally {
		database.close();
	}
});

test("starvation is judged per origin from turn_state: an old accepted trigger is busy, an old unbound row alone is starved", async () => {
	directory = await mkdtemp(join(tmpdir(), "gajaeway-cycle-starve-"));
	const database = await GatewayDatabase.open(join(directory, "gateway.db"));
	try {
		const key = "discord/dm/c1/peer=p1";
		database.putSession(key, "sess-bound-000000000");
		const old = new Date(Date.now() - 20 * 60_000).toISOString();
		// An accepted trigger that has been running for 20 minutes is a long turn, not starvation.
		database.inboundEnqueue({
			messageId: "long",
			originKey: key,
			originRefJson: JSON.stringify(discordDm),
			body: "x",
			receivedAt: old,
		});
		database.inboundBindTurn({ messageId: "long", originKey: key, epoch: 0, opRef: "gw-p-long", sessionId: "s1" });
		database.inboundTurnAccept("gw-p-long");
		// A message queued behind it for 20 minutes is waiting on that turn, not stuck.
		database.inboundEnqueue({
			messageId: "queued",
			originKey: key,
			originRefJson: JSON.stringify(discordDm),
			body: "y",
			receivedAt: old,
		});
		const busy = new RuntimeCycleProjector(database, { queueDepth: 0 }).project();
		expect(busy.gates).toEqual([]);
		expect(busy.phase).toBe("dispatching");
		expect(busy.inFlightInbound).toBe(1);
		// Another origin with an old unbound row and nothing in flight is stuck.
		const other = { ...discordDm, conversationId: "c2", peerId: "p2" };
		const otherKey = "discord/dm/c2/peer=p2";
		database.putSession(otherKey, "sess-other-000000000");
		database.inboundEnqueue({
			messageId: "stuck",
			originKey: otherKey,
			originRefJson: JSON.stringify(other),
			body: "z",
			receivedAt: old,
		});
		const starved = new RuntimeCycleProjector(database, { queueDepth: 0 }).project();
		expect(starved.gates).toEqual(["inbound_starved"]);
	} finally {
		database.close();
	}
});

test("durable worker uncertainty and holds gate below capacity without projection writes", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gajaeway-cycle-worker-"));
	const path = join(dir, "gateway.db");
	let database = await GatewayDatabase.open(path);
	const raw = new Database(path);
	const startedAt = "2026-08-01T00:00:00.000Z";
	const endedAt = "2026-08-01T00:01:00.000Z";
	const now = new Date("2026-08-03T00:00:00.000Z");
	const sessionId = "ad2f2494-2584-4d13-b7b6-c6ac24a1087f";
	try {
		database.putSession("work/task/a", sessionId);
		const record = appendAttempt(
			createLaneJobRecord({
				jobId: "lanejob-cycle",
				branch: "main",
				worktreePath: "/work",
				sessionId,
				now: () => new Date(startedAt),
			}),
			{ opRef: "gw-work-cycle", sessionId, startedAt },
		);
		const runtime: WorkAttemptRuntime = {
			opRef: "gw-work-cycle",
			jobId: record.jobId,
			laneKey: "work-a",
			sessionKey: "work/task/a",
			sessionId,
			epoch: 0,
			cwd: "/work",
			startedAt,
			mode: "run",
			sendPhase: "prepared",
			sendEvidence: null,
			terminal: null,
			output: { disposition: "pending", reads: 0, nextReadAt: null, excerpt: null, proof: null, knownSilence: null },
			target: null,
			deliveryId: workAttemptDeliveryId(database.instanceId, record.jobId, "gw-work-cycle"),
			decision: "undecided",
			settledAt: null,
			version: 0,
		};
		database.workAttemptPrepare(runtime, record);
		expect(new RuntimeCycleProjector(database, { queueDepth: 0 }).project(now).gates).toEqual([]);
		database.workAttemptUpdate(runtime.opRef, 0, { sendPhase: "uncertain" });
		database.close();
		database = await GatewayDatabase.open(path);
		for (const table of ["sessions", "lane_jobs", "work_attempt_runtime", "inbound_messages"]) {
			for (const action of ["INSERT", "UPDATE", "DELETE"])
				raw.exec(
					`CREATE TRIGGER readonly_${table}_${action} BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT, 'projection wrote'); END`,
				);
		}
		const before = database.workAttemptGet(runtime.opRef);
		const result = new RuntimeCycleProjector(database, { queueDepth: 0 }).project(now);
		expect(result.phase).toBe("degraded");
		expect(result.gates).toEqual(["worker_send_uncertain"]);
		expect(result.lanes).toMatchObject({ active: 1, max: 8, awaitingOperator: 0, stalled: 0, uncertainAttempts: 1 });
		expect(result.lanes.workerIssues).toEqual([
			{ jobId: record.jobId, laneKey: "work-a", sessionId, opRef: runtime.opRef, reason: "send_uncertain" },
		]);
		expect(database.workAttemptGet(runtime.opRef)).toEqual(before);
		for (const table of ["sessions", "lane_jobs", "work_attempt_runtime", "inbound_messages"]) {
			for (const action of ["INSERT", "UPDATE", "DELETE"]) raw.exec(`DROP TRIGGER readonly_${table}_${action}`);
		}
		const closed = closeAttempt({ record, opRef: runtime.opRef, endState: "terminal_uncertain", endedAt });
		database.workAttemptSettle(runtime.opRef, 1, closed, {
			terminal: { kind: "local", observedAt: endedAt, reasonCode: "recovery_indeterminate" },
			output: { ...runtime.output, disposition: "unavailable" },
			decision: "no_target",
			settledAt: endedAt,
		});
		const held = new RuntimeCycleProjector(database, { queueDepth: 0 }).project(now);
		expect(held.gates).toEqual(["worker_awaiting_operator"]);
		expect(held.lanes.uncertainAttempts).toBe(0);
		expect(held.lanes.workerIssues).toEqual([
			{ jobId: record.jobId, laneKey: "work-a", sessionId, opRef: runtime.opRef, reason: "awaiting_operator" },
		]);
		const stalled = { ...closed, state: "stalled" as const };
		database.putLaneJob({ ...stalled, laneKey: "work-a", json: JSON.stringify(stalled) });
		expect(new RuntimeCycleProjector(database, { queueDepth: 0 }).project(now).gates).toEqual(["worker_stalled"]);
	} finally {
		raw.close();
		database.close();
	}
});

test("settled SQL state cannot retire a worker over corrupt, mismatched or open history", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gajaeway-cycle-corrupt-worker-"));
	const path = join(dir, "gateway.db");
	const database = await GatewayDatabase.open(path);
	const raw = new Database(path);
	const sessionId = "ad2f2494-2584-4d13-b7b6-c6ac24a1087f";
	try {
		database.bumpEpoch("work/task/a", JSON.stringify({ platform: "work", kind: "task", conversationId: "a" }));
		const initial = createLaneJobRecord({
			jobId: "lanejob-corrupt",
			branch: "main",
			worktreePath: "/private-repository",
			sessionId,
		});
		const settled = { ...initial, state: "done" as const };
		database.putLaneJob({ ...settled, laneKey: "work-a", json: JSON.stringify(settled) });
		const projector = new RuntimeCycleProjector(database, { queueDepth: 0 });
		expect(projector.project().gates).toEqual([]);
		const cases = [
			{ json: "{broken", reason: "job_record_invalid" },
			{ json: JSON.stringify(initial), reason: "job_state_mismatch" },
			{ json: JSON.stringify({ ...settled, jobId: "lanejob-wrong" }), reason: "job_identity_mismatch" },
			{
				json: JSON.stringify({
					...appendAttempt(initial, { opRef: "gw-work-open", sessionId, startedAt: initial.createdAt }),
					state: "done",
				}),
				reason: "settled_job_open_attempt",
			},
		];
		for (const entry of cases) {
			raw.query("UPDATE lane_jobs SET record_json = ? WHERE job_id = ?").run(entry.json, initial.jobId);
			const result = projector.project();
			expect(result.gates).toContain("worker_evidence_invalid");
			expect(result.gates).toContain("stale_session_identity");
			expect(result.phase).toBe("degraded");
			expect(result.lanes.workerIssues).toMatchObject([
				{ jobId: initial.jobId, laneKey: "work-a", reason: entry.reason },
			]);
			expect(JSON.stringify(result)).not.toContain("/private-repository");
		}
		raw.query("UPDATE lane_jobs SET record_json = ? WHERE job_id = ?").run(JSON.stringify(settled), initial.jobId);
		raw
			.query("INSERT INTO broker_quarantine(kind, subject_id, cutover_id) VALUES ('work', ?, 'test-cutover')")
			.run(initial.jobId);
		const quarantined = projector.project();
		expect(quarantined.lanes.workerIssues).toEqual([]);
		expect(quarantined.gates).toContain("stale_session_identity");
	} finally {
		raw.close();
		database.close();
	}
});

test("accepted and bound trigger identities expose age without body or age-based failure", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gajaeway-cycle-age-"));
	const path = join(dir, "gateway.db");
	const database = await GatewayDatabase.open(path);
	const raw = new Database(path);
	const old = "2026-08-01T00:00:00.000Z";
	const now = new Date("2026-08-03T00:00:00.000Z");
	try {
		for (const [epoch, state] of ["accepted", "bound"].entries()) {
			const key = `discord/dm/c${epoch}/peer=p1`;
			database.putSession(key, `session-${state}`);
			database.inboundEnqueue({
				messageId: state,
				originKey: key,
				originRefJson: JSON.stringify(discordDm),
				body: "private body",
				receivedAt: old,
			});
			database.inboundBindTurn({
				messageId: state,
				originKey: key,
				epoch,
				opRef: `gw-p-${state}`,
				sessionId: `session-${state}`,
			});
			if (state === "accepted") database.inboundTurnAccept(`gw-p-${state}`);
		}
		raw.query("UPDATE inbound_messages SET dispatched_at = ?").run(old);
		const result = new RuntimeCycleProjector(database, { queueDepth: 0 }).project(now);
		expect(result.phase).toBe("dispatching");
		expect(result.gates).toEqual([]);
		expect(result.inboundTurns).toHaveLength(2);
		expect(result.inboundTurns[0]).toMatchObject({
			opRef: "gw-p-accepted",
			state: "accepted",
			epoch: 0,
			sessionId: "session-accepted",
			ageMs: 48 * 60 * 60_000,
		});
		expect(result.inboundTurns[1]).toMatchObject({
			opRef: "gw-p-bound",
			state: "bound",
			epoch: 1,
			sessionId: "session-bound",
			ageMs: 48 * 60 * 60_000,
		});
		expect(JSON.stringify(result)).not.toContain("private body");
		database.inboundTurnComplete("gw-p-accepted");
		expect(new RuntimeCycleProjector(database, { queueDepth: 0 }).project(now).inboundTurns).toHaveLength(1);
	} finally {
		raw.close();
		database.close();
	}
});

test("persistent persona hold survives restart, malformed evidence stays gated and completed tombstones do not gate", async () => {
	const dir = await mkdtemp(join(tmpdir(), "gajaeway-cycle-persona-hold-"));
	const path = join(dir, "gateway.db");
	let database = await GatewayDatabase.open(path);
	const key = "discord/dm/c1/peer=p1";
	try {
		database.putSession(key, "session-held");
		database.inboundEnqueue({
			messageId: "held",
			originKey: key,
			originRefJson: JSON.stringify(discordDm),
			body: "private",
		});
		database.inboundBindTurn({
			messageId: "held",
			originKey: key,
			epoch: 0,
			opRef: "gw-p-held",
			sessionId: "session-held",
		});
		database.inboundTurnAccept("gw-p-held");
		database.metaSet(
			"persona-recovery-hold:gw-p-held",
			JSON.stringify({
				epoch: 0,
				reason: "status_endpoint_unavailable:endpoint_stale",
				firstObservedAt: "2026-08-02T00:00:00.000Z",
				observedAt: "2026-08-03T00:00:00.000Z",
			}),
		);
		database.close();
		database = await GatewayDatabase.open(path);
		const projector = new RuntimeCycleProjector(database, { queueDepth: 0 });
		const held = projector.project();
		expect(held.phase).toBe("degraded");
		expect(held.gates).toEqual(["persona_recovery_hold"]);
		expect(held.inboundTurns[0]?.recoveryHold).toEqual({
			reason: "status_endpoint_unavailable:endpoint_stale",
			firstObservedAt: "2026-08-02T00:00:00.000Z",
			observedAt: "2026-08-03T00:00:00.000Z",
		});
		expect(database.inboundTurnRow("gw-p-held")?.turn_state).toBe("accepted");
		database.metaSet("persona-recovery-hold:gw-p-held", "broken");
		expect(projector.project().gates).toEqual(["persona_recovery_hold"]);
		expect(projector.project().inboundTurns[0]?.recoveryHold?.reason).toBe("recovery_hold_evidence_invalid");
		database.inboundTurnComplete("gw-p-held");
		expect(projector.project().gates).toEqual([]);
		expect(projector.project().phase).toBe("idle");
	} finally {
		database.close();
	}
});

test("ops.cycle verb serves a fresh fail-closed snapshot over the socket", async () => {
	directory = await mkdtemp(join(tmpdir(), "gajaeway-cycle-e2e-"));
	const config = testConfig(directory);
	const database = await GatewayDatabase.open(config.dbPath);
	const key = "discord/dm/c1/peer=p1";
	// Leave the session mid-rebind so the served projection must gate.
	database.bumpEpoch(key, JSON.stringify(discordDm));
	const ledger = new DeliveryLedger(database);
	ledger.createPending({
		deliveryId: "d1",
		turnId: "t1",
		originKey: key,
		payloadJson: JSON.stringify({ turnId: "t1", origin: discordDm, role: "assistant", text: "hi", final: true }),
	});
	const sessionPort = sessionPortFromResponder({ respond: async () => "mock reply" });
	server = await startUnixServer({ config, database, sessionPort, onStop: () => database.close() });

	// Minimal negotiated client, mirroring server.test.ts's raw-socket helper.
	const frames: unknown[] = [];
	const socket = Bun.connect({
		unix: config.socketPath,
		socket: {
			data(_socket, data) {
				for (const line of new TextDecoder().decode(data).split("\n")) if (line) frames.push(JSON.parse(line));
			},
		},
	});
	const conn = await socket;
	const send = (frame: unknown) => conn.write(`${JSON.stringify(frame)}\n`);
	send({ v: "0.1", type: "hello", payload: { supportedVersions: ["0.1"] } });
	send({ v: "0.1", type: "request", id: "cycle", verb: "ops.cycle" });
	for (let i = 0; i < 100 && frames.length < 2; i++) await Bun.sleep(5);
	conn.end();

	const response = frames.find((f) => (f as { type?: string }).type === "response") as {
		result?: {
			phase?: string;
			gates?: string[];
			sessions?: Array<Record<string, unknown>>;
			deliveries?: Record<string, number>;
		};
	};
	expect(response?.result?.phase).toBe("degraded");
	expect(response?.result?.gates).toContain("stale_session_identity");
	expect(response?.result?.deliveries).toMatchObject({ pending: 1 });
	expect(response?.result?.sessions?.[0]).toMatchObject({ originKey: key, epoch: 1 });
});
