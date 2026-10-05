import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { appendAttempt, createLaneJobRecord } from "@gajae-gateway/subsession";
import { GatewayDatabase, type WorkAttemptRuntime, workAttemptDeliveryId, workAttemptReportId } from "../src/store/db";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	AGENT_DISK_MIN_FREE_BYTES,
	AGENT_DISK_MIN_FREE_RATIO,
	INBOUND_STARVATION_MS,
	MONITOR_TERMINAL_STREAK_THRESHOLD,
	observeAgentDisk,
	projectRuntimeCycle,
	RuntimeCycleProjector,
	type RuntimeCycleSources,
} from "../src/ops/cycle";

const generatedAt = "2026-08-26T00:00:00.000Z";

function sources(overrides: Partial<RuntimeCycleSources> = {}): RuntimeCycleSources {
	const defaults: RuntimeCycleSources = {
		sessionRows: [],
		inboundCounts: new Map(),
		inboundPendingByOrigin: new Map(),
		oldestStarvedPendingMs: null,
		contextByOrigin: new Map(),
		contextDiff: {
			unread: 0,
			expired: 0,
			truncated: 0,
			omittedOldestAt: null,
			omittedNewestAt: null,
			floorAt: null,
		},
		inFlightInbound: 0,
		pendingInbound: 0,
		unknownInboundStates: [],
		deliveryCounts: new Map(),
		unknownDeliveryStates: [],
		unsettledByOrigin: new Map(),
		memoryIntents: new Map(),
		monitorStages: new Map(),
		monitorAuthoringLost: [],
		memoryClosing: false,
		instanceId: "test-instance",
		activeLanes: 0,
		maxLanes: 8,
		settledWorkOrigins: new Set(),
		diagnostics: [],
		agentDisk: null,
		gjcVersion: undefined,
		monitorTerminalStreak: 0,
		brokerRespawnChurn: false,
	};
	const merged = { ...defaults, ...overrides };
	// Mirror the DB snapshot seam: the census total derives from the counts.
	return { ...merged, pendingInbound: overrides.pendingInbound ?? merged.inboundCounts.get("pending") ?? 0 };
}

const boundSession = {
	origin_key: "discord/dm/c1/peer=p1",
	origin_ref_json: JSON.stringify({ platform: "discord", kind: "dm", conversationId: "c1", peerId: "p1" }),
	gjc_session_id: "sess-1234567890abcdef",
	epoch: 3,
	created_at: "2026-08-01T00:00:00.000Z",
	last_activity_at: "2026-08-02T00:00:00.000Z",
	last_bootstrapped_epoch: 3,
	bootstrap_applied_at: "2026-08-01T00:01:00.000Z",
	bootstrap_sections_json: '["Current conversation metadata"]',
	bootstrap_byte_count: 512,
	bootstrap_truncated: 0,
	bootstrap_diagnostics_json: "[]",
};

describe("runtime cycle projection", () => {
	test("a gjc newer than the verified contract is a gate; verified and unknown versions are not", () => {
		expect(projectRuntimeCycle(sources({ gjcVersion: "0.19.0" }), generatedAt).gates).toContain(
			"gjc_unverified_version",
		);
		expect(projectRuntimeCycle(sources({ gjcVersion: "0.18.7" }), generatedAt).gates).not.toContain(
			"gjc_unverified_version",
		);
		expect(projectRuntimeCycle(sources({ gjcVersion: undefined }), generatedAt).gates).not.toContain(
			"gjc_unverified_version",
		);
	});

	// Issue #15: the GJC agent directory grew to 70+ GB with no reaper; the
	// gateway must surface the disk-full cliff before session creation fails.
	test("agent-directory disk headroom below the floor or unobservable is a gate", () => {
		const total = 400 * 1024 ** 3;
		const path = "/home/operator/.gjc/agent";
		const healthy = projectRuntimeCycle(
			sources({ agentDisk: { path, freeBytes: 160 * 1024 ** 3, totalBytes: total } }),
			generatedAt,
		);
		expect(healthy.gates).toEqual([]);
		expect(healthy.agentDisk).toEqual({ path, freeBytes: 160 * 1024 ** 3, totalBytes: total });
		const ratioFloor = Math.ceil(total * AGENT_DISK_MIN_FREE_RATIO);
		const atFloor = projectRuntimeCycle(
			sources({ agentDisk: { path, freeBytes: ratioFloor, totalBytes: total } }),
			generatedAt,
		);
		expect(atFloor.gates).toEqual([]);
		const lowRatio = projectRuntimeCycle(
			sources({ agentDisk: { path, freeBytes: ratioFloor - 1, totalBytes: total } }),
			generatedAt,
		);
		expect(lowRatio.gates).toEqual(["agent_disk_headroom"]);
		expect(lowRatio.phase).toBe("degraded");
		// Small volume: half the disk free still gates when it is under the absolute floor.
		const small = 10 * 1024 ** 3;
		const lowBytes = projectRuntimeCycle(
			sources({ agentDisk: { path, freeBytes: AGENT_DISK_MIN_FREE_BYTES - 1, totalBytes: small } }),
			generatedAt,
		);
		expect(lowBytes.gates).toEqual(["agent_disk_headroom"]);
		// Missing evidence never reads as healthy.
		const unobservable = projectRuntimeCycle(
			sources({ agentDisk: { path, freeBytes: null, totalBytes: null } }),
			generatedAt,
		);
		expect(unobservable.gates).toEqual(["agent_disk_headroom"]);
		// No broker-bound agent directory (isolated tests): nothing to observe, no gate.
		expect(projectRuntimeCycle(sources(), generatedAt).agentDisk).toBeNull();
	});

	test("observeAgentDisk reads filesystem headroom without touching the directory", () => {
		const observed = observeAgentDisk(tmpdir());
		expect(observed.freeBytes).toBeGreaterThan(0);
		expect(observed.totalBytes).toBeGreaterThanOrEqual(observed.freeBytes as number);
		expect(observeAgentDisk(join(tmpdir(), "gajaeway-missing-agent-dir-15"))).toEqual({
			path: join(tmpdir(), "gajaeway-missing-agent-dir-15"),
			freeBytes: null,
			totalBytes: null,
		});
	});

	test("pending work with nothing in flight past the starvation window is a gate, not dispatching", () => {
		const busy = projectRuntimeCycle(
			sources({ inboundCounts: new Map([["pending", 159]]), oldestStarvedPendingMs: INBOUND_STARVATION_MS - 1 }),
			generatedAt,
		);
		expect(busy.phase).toBe("dispatching");
		expect(busy.gates).toEqual([]);
		const starved = projectRuntimeCycle(
			sources({ inboundCounts: new Map([["pending", 159]]), oldestStarvedPendingMs: INBOUND_STARVATION_MS }),
			generatedAt,
		);
		expect(starved.phase).toBe("degraded");
		expect(starved.gates).toEqual(["inbound_starved"]);
	});

	test("issue #189: a run of terminal monitor failures degrades the cycle even with no failed/stuck rows", () => {
		// 26 consecutive failed_no_retry slots projected idle: failed_no_retry is
		// terminal, so neither monitor_settlement_failed nor _stuck ever fired.
		const below = projectRuntimeCycle(
			sources({
				monitorStages: new Map([["failed_no_retry", 2]]),
				monitorTerminalStreak: MONITOR_TERMINAL_STREAK_THRESHOLD - 1,
			}),
			generatedAt,
		);
		expect(below.gates).toEqual([]);
		expect(below.phase).toBe("idle");
		const outage = projectRuntimeCycle(
			sources({ monitorStages: new Map([["failed_no_retry", 26]]), monitorTerminalStreak: 26 }),
			generatedAt,
		);
		expect(outage.gates).toEqual(["monitor_dispatch_failing"]);
		expect(outage.phase).toBe("degraded");
	});

	test("issue #189: broker respawn churn is a gate, not a string of healthy verdicts", () => {
		const churn = projectRuntimeCycle(sources({ brokerRespawnChurn: true }), generatedAt);
		expect(churn.gates).toEqual(["broker_respawn_churn"]);
		expect(churn.phase).toBe("degraded");
	});

	test("empty durable state projects idle with no gates", () => {
		const result = projectRuntimeCycle(sources(), generatedAt);
		expect(result.phase).toBe("idle");
		expect(result.gates).toEqual([]);
		expect(result.sessions).toEqual([]);
		expect(result.generatedAt).toBe(generatedAt);
		expect(result.instanceId).toBe("test-instance");
	});

	test("a saturated lane cap gates lane_capacity_exhausted and reports the census", () => {
		const result = projectRuntimeCycle(sources({ activeLanes: 8, maxLanes: 8 }), generatedAt);
		expect(result.gates).toContain("lane_capacity_exhausted");
		expect(result.phase).toBe("degraded");
		expect(result.lanes).toEqual({ active: 8, max: 8 });
		const below = projectRuntimeCycle(sources({ activeLanes: 7, maxLanes: 8 }), generatedAt);
		expect(below.gates).toEqual([]);
		expect(below.lanes).toEqual({ active: 7, max: 8 });
	});

	test("an unbound worker lane is retired only on positive settled-job evidence", () => {
		const unbound = {
			...boundSession,
			origin_key: "work/task/repo-fix",
			origin_ref_json: JSON.stringify({ platform: "work", kind: "task", conversationId: "repo-fix" }),
			gjc_session_id: "",
			epoch: 2,
		};
		// Retired: the lane job settled (done/aborted/attempt_ended) and the binding was cleared.
		const retired = projectRuntimeCycle(
			sources({ sessionRows: [unbound], settledWorkOrigins: new Set(["work/task/repo-fix"]) }),
			generatedAt,
		);
		expect(retired.gates).toEqual([]);
		expect(retired.phase).toBe("idle");
		// No lane job at all: a failed first bind (rebindEpoch runs before the job
		// row exists). Same row shape, but nothing vouches for it: stays gated.
		const failedBind = projectRuntimeCycle(sources({ sessionRows: [unbound] }), generatedAt);
		expect(failedBind.gates).toContain("stale_session_identity");
		expect(failedBind.phase).toBe("degraded");
	});

	test("healthy bound session with no work projects idle and carries identity/provenance", () => {
		const result = projectRuntimeCycle(sources({ sessionRows: [boundSession] }), generatedAt);
		expect(result.phase).toBe("idle");
		expect(result.gates).toEqual([]);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0]).toMatchObject({
			originKey: "discord/dm/c1/peer=p1",
			epoch: 3,
			sessionId: "sess-1234567890abcdef",
			pendingInbound: 0,
			unsettledDeliveries: 0,
			oldestUnsettledAgeMs: null,
		});
		expect(result.sessions[0].origin).toMatchObject({ platform: "discord", kind: "dm" });
	});

	test("mid-rebind session (empty gjc session id) gates as stale identity, never healthy", () => {
		const result = projectRuntimeCycle(
			sources({ sessionRows: [{ ...boundSession, gjc_session_id: "", epoch: 4 }] }),
			generatedAt,
		);
		// Fail-closed: epoch is visible but identity is unbound; the operator must see it.
		expect(result.gates).toContain("stale_session_identity");
		expect(result.phase).toBe("degraded");
		expect(result.sessions[0].sessionId).toBe("");
		expect(result.sessions[0].epoch).toBe(4);
	});

	test("claimed inbound message projects dispatching", () => {
		const result = projectRuntimeCycle(sources({ inFlightInbound: 1 }), generatedAt);
		expect(result.phase).toBe("dispatching");
		expect(result.gates).toEqual([]);
	});

	test("pending (unclaimed) inbound also projects dispatching", () => {
		const result = projectRuntimeCycle(sources({ inboundCounts: new Map([["pending", 2]]) }), generatedAt);
		expect(result.phase).toBe("dispatching");
		expect(result.inFlightInbound).toBe(0);
	});

	test("unsettled delivery projects delivering; settled alone does not", () => {
		const delivering = projectRuntimeCycle(
			sources({ unsettledByOrigin: new Map([["k", { n: 1, oldestMs: 5_000 }]]) }),
			generatedAt,
		);
		expect(delivering.phase).toBe("delivering");
		const settled = projectRuntimeCycle(
			sources({
				deliveryCounts: new Map([
					["confirmed", 7],
					["expired", 2],
				]),
			}),
			generatedAt,
		);
		expect(settled.phase).toBe("idle");
		expect(settled.deliveries).toEqual({
			pending: 0,
			inflight: 0,
			confirmed: 7,
			failedAmbiguous: 0,
			expired: 2,
		});
	});

	test("pending inbound for an origin with no session row still counts in the census", () => {
		// First-message case: inboundEnqueue is durable before ensureSession ever runs,
		// so a session-summing census would read pending=0 while the phase says dispatching.
		const result = projectRuntimeCycle(sources({ inboundCounts: new Map([["pending", 3]]) }), generatedAt);
		expect(result.phase).toBe("dispatching");
		expect(result.pendingInbound).toBe(3);
		expect(result.inFlightInbound).toBe(0);
	});

	test("in-flight memory closure projects draining", () => {
		const result = projectRuntimeCycle(sources({ memoryClosing: true }), generatedAt);
		expect(result.phase).toBe("draining");
		expect(result.memoryClosing).toBe(true);
	});

	test("durable unsettled memory intents also project draining across a restart", () => {
		// queueDepth is in-memory and lost on restart; the durable census is not.
		const result = projectRuntimeCycle(
			sources({
				memoryIntents: new Map([
					["written", 1],
					["committed", 2],
				]),
			}),
			generatedAt,
		);
		expect(result.phase).toBe("draining");
		expect(result.memoryClosing).toBe(true);
		expect(result.memoryIntents).toMatchObject({ written: 1, committed: 2 });
	});

	test("quarantined memory intent gates memory_closure_blocked and degrades", () => {
		const result = projectRuntimeCycle(sources({ memoryIntents: new Map([["quarantined", 1]]) }), generatedAt);
		expect(result.gates).toContain("memory_closure_blocked");
		expect(result.phase).toBe("degraded");
	});

	test("failed monitor event gates monitor_settlement_failed and degrades", () => {
		const result = projectRuntimeCycle(
			sources({
				monitorStages: new Map([
					["failed", 1],
					["delivered", 5],
				]),
			}),
			generatedAt,
		);
		expect(result.gates).toContain("monitor_settlement_failed");
		expect(result.phase).toBe("degraded");
		expect(result.monitorEvents).toEqual([
			{ stage: "delivered", count: 5 },
			{ stage: "failed", count: 1 },
		]);
	});

	test("failed_ambiguous deliveries are unsettled work but not a gate by themselves", () => {
		const result = projectRuntimeCycle(
			sources({
				deliveryCounts: new Map([["failed_ambiguous", 1]]),
				unsettledByOrigin: new Map([["k", { n: 1, oldestMs: 60_000 }]]),
			}),
			generatedAt,
		);
		// Ambiguity is honest at-least-once semantics, not unknown settlement.
		expect(result.gates).toEqual([]);
		expect(result.phase).toBe("delivering");
		expect(result.deliveries.failedAmbiguous).toBe(1);
	});

	test("unknown delivery state gates delivery_settlement_unknown — never silently healthy", () => {
		const result = projectRuntimeCycle(
			sources({
				deliveryCounts: new Map([
					["pending", 1],
					["bound", 1],
				]),
				unknownDeliveryStates: ["bound"],
			}),
			generatedAt,
		);
		expect(result.gates).toContain("delivery_settlement_unknown");
		expect(result.phase).toBe("degraded");
	});

	test("unknown inbound queue state also gates delivery_settlement_unknown", () => {
		const result = projectRuntimeCycle(sources({ unknownInboundStates: ["poof"] }), generatedAt);
		expect(result.gates).toContain("delivery_settlement_unknown");
		expect(result.phase).toBe("degraded");
	});

	test("degraded dominates concurrent busy work — never reported as merely dispatching", () => {
		const result = projectRuntimeCycle(
			sources({
				inFlightInbound: 2,
				unsettledByOrigin: new Map([["k", { n: 3, oldestMs: 1_000 }]]),
				memoryIntents: new Map([["quarantined", 1]]),
			}),
			generatedAt,
		);
		expect(result.phase).toBe("degraded");
		expect(result.gates).toEqual(["memory_closure_blocked"]);
	});

	test("per-origin pending inbound and unsettled delivery ages attach to the right session", () => {
		const result = projectRuntimeCycle(
			sources({
				sessionRows: [boundSession],
				inboundPendingByOrigin: new Map([["discord/dm/c1/peer=p1", 2]]),
				unsettledByOrigin: new Map([["discord/dm/c1/peer=p1", { n: 1, oldestMs: 42_000 }]]),
			}),
			generatedAt,
		);
		expect(result.sessions[0].pendingInbound).toBe(2);
		expect(result.sessions[0].unsettledDeliveries).toBe(1);
		expect(result.sessions[0].oldestUnsettledAgeMs).toBe(42_000);
	});

	test("aggregate and per-origin context drift project without exposing message bodies", () => {
		const context = {
			unread: 4,
			expired: 287,
			truncated: 12,
			omittedOldestAt: "2026-08-27T00:00:00.000Z",
			omittedNewestAt: "2026-08-28T01:00:00.000Z",
			floorAt: "2026-08-28T02:00:00.000Z",
		};
		const result = projectRuntimeCycle(
			sources({
				sessionRows: [boundSession],
				contextByOrigin: new Map([[boundSession.origin_key, context]]),
				contextDiff: { ...context, floorAt: null },
			}),
			generatedAt,
		);
		expect(result.contextDiff).toEqual({ ...context, floorAt: null });
		expect(result.sessions[0]?.contextDiff).toEqual(context);
		expect(JSON.stringify(result)).not.toContain("private body");
	});

	test("an unparseable stored origin ref still surfaces the session instead of hiding it", () => {
		const result = projectRuntimeCycle(
			sources({ sessionRows: [{ ...boundSession, origin_ref_json: "{not json" }] }),
			generatedAt,
		);
		expect(result.sessions).toHaveLength(1);
		expect(result.sessions[0].originKey).toBe(boundSession.origin_key);
	});
});

const diagnosticSession = "ad2f2494-2584-4d13-b7b6-c6ac24a1087f";

async function diagnosticFixture() {
	const home = await mkdtemp(join(tmpdir(), "cycle-diagnostics-"));
	const path = join(home, "gateway.db");
	const database = await GatewayDatabase.open(path);
	const raw = new Database(path);
	const project = () => {
		const tables = raw
			.query<{ name: string }, []>(
				"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
			)
			.all();
		const snapshot = () => tables.map(({ name }) => raw.query(`SELECT * FROM "${name}"`).all());
		const before = snapshot();
		// A projection attempting any durable write must fail, even an idempotent one.
		for (const { name } of tables)
			for (const action of ["INSERT", "UPDATE", "DELETE"]) {
				raw.exec(
					`CREATE TRIGGER "cycle_guard_${name}_${action}" BEFORE ${action} ON "${name}" BEGIN SELECT RAISE(ABORT, 'projection_write'); END`,
				);
			}
		try {
			const cycle = new RuntimeCycleProjector(database, { queueDepth: 0 }).project(new Date(generatedAt));
			expect(snapshot()).toEqual(before);
			return cycle;
		} finally {
			for (const { name } of tables)
				for (const action of ["INSERT", "UPDATE", "DELETE"]) raw.exec(`DROP TRIGGER "cycle_guard_${name}_${action}"`);
		}
	};
	return {
		database,
		raw,
		project,
		close: async () => {
			raw.close();
			database.close();
			await rm(home, { recursive: true, force: true });
		},
	};
}

function diagnosticJob(
	f: Awaited<ReturnType<typeof diagnosticFixture>>,
	state: "running" | "done" | "awaiting_operator" | "stalled",
	open = false,
) {
	const initial = createLaneJobRecord({
		jobId: "lanejob-61",
		branch: "main",
		worktreePath: "/work",
		sessionId: diagnosticSession,
		now: () => new Date(generatedAt),
	});
	const record = {
		...(open
			? appendAttempt(initial, { opRef: "gw-cycle-worker", sessionId: diagnosticSession, startedAt: generatedAt })
			: initial),
		state,
	};
	f.database.putLaneJob({ ...record, laneKey: "work-a", json: JSON.stringify(record) });
	return record;
}

function diagnosticRuntime(f: Awaited<ReturnType<typeof diagnosticFixture>>) {
	const record = diagnosticJob(f, "running", true);
	const runtime: WorkAttemptRuntime = {
		opRef: "gw-cycle-worker",
		jobId: record.jobId,
		laneKey: "work-a",
		sessionKey: "work/task/a",
		sessionId: diagnosticSession,
		epoch: 0,
		cwd: "/work",
		startedAt: generatedAt,
		mode: "run",
		sendPhase: "uncertain",
		sendEvidence: null,
		terminal: null,
		output: { disposition: "pending", reads: 0, nextReadAt: null, excerpt: null, proof: null, knownSilence: null },
		parent: null,
		reportId: workAttemptReportId(f.database.instanceId, record.jobId, "gw-cycle-worker"),
		wakeReportId: null,
		noticeHash: null,
		deliveryId: workAttemptDeliveryId(f.database.instanceId, record.jobId, "gw-cycle-worker"),
		decision: "undecided",
		settledAt: null,
		version: 0,
	};
	f.raw
		.query(
			"INSERT INTO work_attempt_runtime(op_ref, job_id, lane_key, session_id, version, settled_at, delivery_id, record_json) VALUES (?, ?, ?, ?, 0, NULL, ?, ?)",
		)
		.run(runtime.opRef, runtime.jobId, runtime.laneKey, runtime.sessionId, runtime.deliveryId, JSON.stringify(runtime));
	return runtime;
}

describe("durable cycle diagnostics", () => {
	test("exact active persona hold gates with all IDs; invalid evidence fails closed and completed stale holds are ignored", async () => {
		const f = await diagnosticFixture();
		try {
			const originKey = boundSession.origin_key;
			f.database.putSession(originKey, diagnosticSession);
			f.database.inboundEnqueue({
				messageId: "held",
				originKey,
				originRefJson: boundSession.origin_ref_json,
				body: "SECRET_PROMPT",
				receivedAt: generatedAt,
			});
			f.database.inboundBindTurn({
				messageId: "held",
				originKey,
				epoch: 0,
				opRef: "gw-p-held",
				sessionId: diagnosticSession,
			});
			const key = "persona-recovery-hold:gw-p-held";
			const hold = {
				originKey,
				epoch: 0,
				sessionId: diagnosticSession,
				opRef: "gw-p-held",
				firstObservedAt: generatedAt,
				observedAt: generatedAt,
				reason: "SECRET_REASON",
			};
			const valid = JSON.stringify(hold);
			const invalids = [
				"{SECRET_JSON",
				"null",
				JSON.stringify({ ...hold, firstObservedAt: "bad" }),
				JSON.stringify({ ...hold, observedAt: "bad" }),
				JSON.stringify({ ...hold, observedAt: "2026-08-25T23:59:59.999Z" }),
				JSON.stringify({ ...hold, firstObservedAt: "2026-10-03" }),
				JSON.stringify({ ...hold, originKey: "foreign" }),
				JSON.stringify({ ...hold, epoch: 1 }),
				JSON.stringify({ ...hold, sessionId: "foreign" }),
				JSON.stringify({ ...hold, opRef: "foreign" }),
			];
			for (const raw of [valid, ...invalids]) {
				f.database.metaSet(key, raw);
				const cycle = f.project();
				expect(cycle.phase).toBe("degraded");
				expect(cycle.gates).toEqual(["persona_recovery_hold"]);
				expect(cycle.diagnostics).toEqual([
					{
						reason: "persona_recovery_hold",
						originKey,
						jobId: null,
						laneKey: null,
						sessionId: diagnosticSession,
						opRef: "gw-p-held",
						detail: raw === valid ? null : "invalid",
					},
				]);
				expect(JSON.stringify(cycle)).not.toContain("SECRET");
				expect(f.database.metaGet(key)).toBe(raw);
			}
			f.database.inboundTurnComplete("gw-p-held");
			expect(f.project().diagnostics).toEqual([]);
			expect(f.project().phase).toBe("idle");
		} finally {
			await f.close();
		}
	});

	test("settled retirement requires valid JSON, matching SQL identity/state/branch/worktree and no open attempt", async () => {
		const f = await diagnosticFixture();
		try {
			f.database.putSession("work/task/a", "");
			const valid = diagnosticJob(f, "done");
			expect(f.project().gates).toEqual([]);
			for (const patch of [
				"{SECRET_JOB",
				JSON.stringify({ ...valid, jobId: "lanejob-foreign" }),
				JSON.stringify({ ...valid, state: "running" }),
				JSON.stringify({ ...valid, lane: { ...valid.lane, branch: "foreign" } }),
				JSON.stringify({ ...valid, lane: { ...valid.lane, worktreePath: "/foreign" } }),
			]) {
				f.raw.query("UPDATE lane_jobs SET record_json = ? WHERE job_id = ?").run(patch, valid.jobId);
				const cycle = f.project();
				expect(cycle.gates).toContain("worker_evidence_invalid");
				expect(cycle.gates).toContain("stale_session_identity");
				expect(cycle.diagnostics).toEqual([
					{
						reason: "worker_evidence_invalid",
						originKey: "work/task/a",
						jobId: valid.jobId,
						laneKey: "work-a",
						sessionId: null,
						opRef: null,
						detail: "invalid",
					},
				]);
				expect(JSON.stringify(cycle)).not.toContain("SECRET");
			}
			diagnosticJob(f, "done", true);
			expect(f.project().gates).toContain("stale_session_identity");
			expect(f.project().gates).toContain("worker_evidence_invalid");
		} finally {
			await f.close();
		}
	});

	test("awaiting operator and stalled jobs have distinct actionable gates even without open runtimes", async () => {
		const f = await diagnosticFixture();
		try {
			for (const state of ["awaiting_operator", "stalled"] as const) {
				diagnosticJob(f, state, true);
				const reason = state === "stalled" ? "worker_stalled" : "worker_awaiting_operator";
				const cycle = f.project();
				expect(cycle.gates).toEqual([reason]);
				expect(cycle.diagnostics).toEqual([
					{
						reason,
						originKey: "work/task/a",
						jobId: "lanejob-61",
						laneKey: "work-a",
						sessionId: diagnosticSession,
						opRef: "gw-cycle-worker",
						detail: null,
					},
				]);
			}
		} finally {
			await f.close();
		}
	});

	test("uncertain sends retain exact validated IDs; corrupt open runtime retains SQL IDs and cannot prove retirement", async () => {
		const f = await diagnosticFixture();
		try {
			const runtime = diagnosticRuntime(f);
			const ids = {
				originKey: runtime.sessionKey,
				jobId: runtime.jobId,
				laneKey: runtime.laneKey,
				sessionId: runtime.sessionId,
				opRef: runtime.opRef,
			};
			expect(f.project().diagnostics).toEqual([{ reason: "worker_send_uncertain", ...ids, detail: null }]);
			f.raw.query("DELETE FROM lane_jobs WHERE job_id = ?").run(runtime.jobId);
			expect(f.project().diagnostics).toEqual([{ reason: "worker_evidence_invalid", ...ids, detail: "invalid" }]);
			diagnosticJob(f, "running", true);
			for (const raw of [
				"{SECRET_RUNTIME",
				JSON.stringify({ ...runtime, opRef: "gw-forged-runtime" }),
				JSON.stringify({ ...runtime, sessionId: "foreign" }),
				JSON.stringify({ ...runtime, sendPhase: "unknown" }),
			]) {
				f.raw.query("UPDATE work_attempt_runtime SET record_json = ? WHERE op_ref = ?").run(raw, runtime.opRef);
				const cycle = f.project();
				expect(cycle.gates).toContain("worker_evidence_invalid");
				expect(cycle.diagnostics).toEqual([{ reason: "worker_evidence_invalid", ...ids, detail: "invalid" }]);
				expect(JSON.stringify(cycle)).not.toContain("SECRET");
			}
			f.database.putSession("work/task/a", "");
			diagnosticJob(f, "done");
			expect(f.project().gates).toContain("stale_session_identity");
		} finally {
			await f.close();
		}
	});
});
