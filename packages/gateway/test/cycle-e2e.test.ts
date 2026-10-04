import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OriginRef } from "@gajae-gateway/protocol";
import type { GatewayConfig } from "../src/config";
import { RuntimeCycleProjector } from "../src/ops/cycle";
import { type GatewayServer, startUnixServer } from "../src/server/server";
import { GatewayDatabase } from "../src/store/db";
import { DeliveryLedger } from "../src/store/ledger";
import { sessionPortFromResponder } from "./session-port.fake";

let directory = "";
let server: GatewayServer | undefined;

afterEach(async () => {
	await server?.stop("test teardown");
	server = undefined;
});

const discordDm: OriginRef = { platform: "discord", kind: "dm", conversationId: "c1", peerId: "p1" };

const cutoverAuthority = { canonicalAgentDir: "/test/global-agent", identity: "global" };

function cutover(database: GatewayDatabase) {
	return database.cutoverBrokerAuthority({
		expectedAuthority: null,
		targetAuthority: cutoverAuthority,
		evidence: "Test-authorized cutover",
		disposition: "quarantine",
	});
}

test("idle cutover survives reopen, but later resets, missing origins and failed initial binds stay gated", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cycle-cutover-"));
	const path = join(dir, "gateway.db");
	let database = await GatewayDatabase.open(path);
	const key = "discord/dm/c1/peer=p1";
	try {
		database.putSession(key, "prior-session");
		cutover(database);
		database.close();
		database = await GatewayDatabase.open(path);
		const project = () => new RuntimeCycleProjector(database, { queueDepth: 0 }).project();
		expect(project().gates).toEqual([]);
		expect(project().phase).toBe("idle");
		expect(project().sessions[0]).toMatchObject({ epoch: 1, sessionId: "" });
		// Read-only projection does not bind or mutate the cutover identity.
		expect(database.getSessionRecord(key)?.sessionId).toBe("");
		database.bumpEpoch(key, JSON.stringify(discordDm));
		database.contextSetFloor(key);
		expect(project().gates).toContain("stale_session_identity");
		database.recordOwnedBinding({
			originKey: key,
			sessionId: "rebound",
			epoch: 2,
			repo: "/test/repo",
			authority: cutoverAuthority,
		});
		database.rebindEpoch("discord/channel/missing-from-snapshot");
		expect(project().gates).toContain("stale_session_identity");
	} finally {
		database.close();
	}
});

test("a failed first bind stays gated until explicit cutover proves an idle reset", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cycle-cutover-failed-"));
	const database = await GatewayDatabase.open(join(dir, "gateway.db"));
	try {
		database.rebindEpoch("discord/channel/failed");
		expect(new RuntimeCycleProjector(database, { queueDepth: 0 }).project().gates).toContain("stale_session_identity");
		cutover(database);
		const result = new RuntimeCycleProjector(database, { queueDepth: 0 }).project();
		expect(result.gates).toEqual([]);
		expect(result.phase).toBe("idle");
	} finally {
		database.close();
	}
});

test("cutover evidence must belong to the current authority", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cycle-cutover-authority-"));
	const database = await GatewayDatabase.open(join(dir, "gateway.db"));
	const raw = new Database(join(dir, "gateway.db"));
	try {
		database.putSession("discord/channel/old", "prior-session");
		cutover(database);
		database.cutoverBrokerAuthority({
			expectedAuthority: cutoverAuthority,
			targetAuthority: { canonicalAgentDir: "/test/next-agent", identity: "next" },
			evidence: "Second authorized cutover",
		});
		expect(new RuntimeCycleProjector(database, { queueDepth: 0 }).project().phase).toBe("idle");
		// Only the obsolete authority's snapshot matches this epoch, not the current one.
		raw.query("UPDATE sessions SET epoch = 1 WHERE origin_key = 'discord/channel/old'").run();
		expect(new RuntimeCycleProjector(database, { queueDepth: 0 }).project().gates).toContain("stale_session_identity");
	} finally {
		raw.close();
		database.close();
	}
});

for (const scenario of [
	"pending",
	"processing",
	"bound",
	"accepted",
	"held-steer",
	"done-nonterminal",
	"done",
] as const) {
	test(`cutover checks quarantined old-epoch inbound: ${scenario}`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "cycle-cutover-inbound-"));
		const path = join(dir, "gateway.db");
		const database = await GatewayDatabase.open(path);
		const raw = new Database(path);
		const key = "discord/dm/c1/peer=p1";
		try {
			database.putSession(key, "prior-session");
			database.inboundEnqueue({
				messageId: "m",
				originKey: key,
				originRefJson: JSON.stringify(discordDm),
				body: "preserve",
			});
			if (scenario === "held-steer") database.inboundSteerIssued({ messageId: "m", epoch: 0, opRef: "old-op" });
			else if (["bound", "accepted", "done-nonterminal"].includes(scenario)) {
				database.inboundBindTurn({
					messageId: "m",
					originKey: key,
					epoch: 0,
					opRef: "old-op",
					sessionId: "prior-session",
				});
				if (scenario === "accepted") database.inboundTurnAccept("old-op");
			}
			if (scenario === "processing") raw.query("UPDATE inbound_messages SET state = 'processing'").run();
			if (scenario === "done" || scenario === "done-nonterminal")
				raw.query("UPDATE inbound_messages SET state = 'done'").run();
			cutover(database);
			const before = raw.query("SELECT * FROM inbound_messages").all();
			const result = new RuntimeCycleProjector(database, { queueDepth: 0 }).project();
			expect(result.sessions[0].pendingInbound).toBe(0); // Quarantine hides rows from the replayable census, not this guard.
			expect(result.gates.includes("stale_session_identity")).toBe(scenario !== "done");
			expect(raw.query("SELECT * FROM inbound_messages").all()).toEqual(before);
		} finally {
			raw.close();
			database.close();
		}
	});
}

for (const stage of [
	"admitted",
	"batched",
	"dispatched",
	"authored",
	"failed",
	"delivered",
	"authored_no_delivery",
	"failed_no_retry",
] as const) {
	test(`cutover monitor guard includes quarantined events and catch-all routing: ${stage}`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "cycle-cutover-monitor-"));
		const database = await GatewayDatabase.open(join(dir, "gateway.db"));
		const raw = new Database(join(dir, "gateway.db"));
		try {
			database.putSession("monitor/eventtype/catch-all", "prior-monitor-session");
			database.monitorEventCreate({
				eventId: "event",
				monitorId: "monitor",
				eventType: "another-type",
				payloadJson: "{}",
				firedAt: new Date().toISOString(),
			});
			database.monitorEventUpdate("event", stage);
			raw.query("UPDATE monitor_events SET updated_at = '2000-01-01T00:00:00.000Z'").run();
			cutover(database);
			const result = new RuntimeCycleProjector(database, { queueDepth: 0 }).project();
			expect(result.gates.includes("stale_session_identity")).toBe(
				!["delivered", "authored_no_delivery", "failed_no_retry"].includes(stage),
			);
		} finally {
			raw.close();
			database.close();
		}
	});
}

test("a monitor failure exhausted at or after cutover vetoes idle", async () => {
	const dir = await mkdtemp(join(tmpdir(), "cycle-cutover-exhausted-"));
	const database = await GatewayDatabase.open(join(dir, "gateway.db"));
	const raw = new Database(join(dir, "gateway.db"));
	try {
		database.putSession("monitor/eventtype/catch-all", "prior-monitor-session");
		cutover(database);
		database.monitorEventCreate({
			eventId: "new",
			monitorId: "monitor",
			eventType: "another-type",
			payloadJson: "{}",
			firedAt: new Date().toISOString(),
		});
		database.monitorEventUpdate("new", "failed_no_retry");
		const project = () => new RuntimeCycleProjector(database, { queueDepth: 0 }).project();
		expect(project().gates).toContain("stale_session_identity");
		raw.query("UPDATE monitor_events SET updated_at = (SELECT created_at FROM broker_cutovers LIMIT 1)").run();
		expect(project().gates).toContain("stale_session_identity");
	} finally {
		raw.close();
		database.close();
	}
});

for (const snapshot of [
	"not-json",
	'{"sessions":["not-json"]}',
	'{"sessions":[null,1,true,[]]}',
	'{"sessions":[{"origin_key":"discord/channel/test","epoch":0,"gjc_session_id":null}]}',
]) {
	test(`malformed snapshot is not idle evidence: ${snapshot}`, async () => {
		const dir = await mkdtemp(join(tmpdir(), "cycle-cutover-malformed-"));
		const database = await GatewayDatabase.open(join(dir, "gateway.db"));
		const raw = new Database(join(dir, "gateway.db"));
		try {
			database.assertBrokerAuthority(cutoverAuthority, { initializeEmpty: true });
			database.rebindEpoch("discord/channel/test");
			// Insert malformed provenance only into this isolated test database.
			raw
				.query(
					"INSERT INTO broker_cutovers(id, target_authority, evidence, disposition, snapshot_json, created_at) SELECT 'malformed', authority_key, 'test', 'quiescent', ?, ? FROM broker_authority",
				)
				.run(snapshot, new Date().toISOString());
			const result = new RuntimeCycleProjector(database, { queueDepth: 0 }).project();
			expect(result.gates).toContain("stale_session_identity");
			expect(result.phase).toBe("degraded");
		} finally {
			raw.close();
			database.close();
		}
	});
}

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
		expect(afterBump.gates).toContain("stale_session_identity");
		expect(afterBump.phase).toBe("degraded");
		expect(afterBump.sessions[0]).toMatchObject({ originKey: key, epoch: 1, sessionId: "" });

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
