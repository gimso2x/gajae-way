import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOOPBACK_ORIGIN } from "@gajae-gateway/protocol";
import { DeliveryService } from "../src/delivery/delivery";
import { MonitorPropagator } from "../src/monitors/propagate";
import { MonitorRegistry } from "../src/monitors/registry";
import { GatewayDatabase } from "../src/store/db";
import { DeliveryLedger } from "../src/store/ledger";
import { ScriptedSessionPort } from "./session-port.fake";

/**
 * Silence settlement + batch join + prompt-assembly acceptance harness (spec
 * rev2 tests a-d, f). The scripted port answers the authoring turn from
 * `noteFor`, so every note is decided per event id while the whole real
 * pipeline (burst batching, leases, fenced writes, ledger, delivery) runs.
 */
async function openPipeline(
	dbPath: string,
	noteFor: (eventId: string) => string,
): Promise<{
	database: GatewayDatabase;
	registry: MonitorRegistry;
	pipeline: MonitorPropagator;
	prompts: string[];
	deliveries: Array<{ turnId?: string; text?: string }>;
}> {
	const database = await GatewayDatabase.open(dbPath);
	const registry = new MonitorRegistry(database);
	const prompts: string[] = [];
	const deliveries: Array<{ turnId?: string; text?: string }> = [];
	const sessionPort = new ScriptedSessionPort({
		onSend: (input, scripted) => {
			prompts.push(input.text);
			const marker = "entry per event: ";
			const claimed = JSON.parse(input.text.slice(input.text.lastIndexOf(marker) + marker.length)) as Array<{
				eventId: string;
			}>;
			scripted.complete(
				input.opRef,
				JSON.stringify(claimed.map(({ eventId }) => ({ eventId, note: noteFor(eventId) }))),
			);
		},
	});
	const pipeline = new MonitorPropagator({
		database,
		registry,
		sessionPort,
		memory: { enqueue: () => crypto.randomUUID(), enqueueExistingId: () => {} } as never,
		delivery: new DeliveryService(new DeliveryLedger(database)),
		emit: () => {},
		ownerTarget: { origin: LOOPBACK_ORIGIN },
		deliver: (payload) => deliveries.push(payload as { turnId?: string; text?: string }),
	});
	return { database, registry, pipeline, prompts, deliveries };
}

function intentsFor(database: GatewayDatabase, eventId: string): number {
	return database
		.memoryIntentRows()
		.filter((intent) => intent.kind === "monitor-event" && intent.payload_json.includes(eventId)).length;
}

test("a single [SILENT] note settles terminally with no delivery and exactly one memory intent (test a)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gajaeway-monitor-silence-a-"));
	try {
		const { database, registry, pipeline, prompts, deliveries } = await openPipeline(
			join(directory, "gateway.db"),
			() => "[SILENT]",
		);
		const monitor = registry.add({
			name: "quiet-canonicalize",
			trigger: { kind: "cron", schedule: "* * * * *" },
			eventTypes: ["memory.canonicalize"],
		});
		const eventId = pipeline.submit(monitor.monitorId, "memory.canonicalize", {});
		await Bun.sleep(500);
		const row = database.monitorEventRows().find((candidate) => candidate.event_id === eventId)!;
		// Terminal, not the live `authored` stage reconcile would keep reviving.
		expect(row.stage).toBe("authored_no_delivery");
		// No deliveries row was created at all, and no adapter push happened.
		expect(database.deliveryRows()).toHaveLength(0);
		expect(deliveries).toHaveLength(0);
		// The authored output and exactly one memory intent survive.
		expect(database.authoredOutput(eventId)).toBe("[SILENT]");
		expect(intentsFor(database, eventId)).toBe(1);
		expect(prompts).toHaveLength(1);
		database.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("an all-silent batch sends nothing — [SILENT]\\n[SILENT] never leaves (test b)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gajaeway-monitor-silence-b-"));
	try {
		const { database, registry, pipeline, prompts, deliveries } = await openPipeline(
			join(directory, "gateway.db"),
			() => "[SILENT]",
		);
		const monitor = registry.add({
			name: "quiet-audit",
			trigger: { kind: "cron", schedule: "* * * * *" },
			eventTypes: ["memory.audit"],
		});
		const first = pipeline.submit(monitor.monitorId, "memory.audit", { i: 1 });
		const second = pipeline.submit(monitor.monitorId, "memory.audit", { i: 2 });
		await Bun.sleep(500);
		// Both notes were authored in ONE batched turn (the join under test).
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toContain(first);
		expect(prompts[0]).toContain(second);
		const stages = database
			.monitorEventRows()
			.filter((row) => row.event_id === first || row.event_id === second)
			.map((row) => row.stage);
		expect(stages).toEqual(["authored_no_delivery", "authored_no_delivery"]);
		// The joined text `[SILENT]\n[SILENT]` must never reach the ledger or an adapter.
		expect(database.deliveryRows()).toHaveLength(0);
		expect(deliveries).toHaveLength(0);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a mixed batch delivers only the spoken notes; silent events still settle terminally (test c)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gajaeway-monitor-silence-c-"));
	try {
		const notes = new Map<string, string>();
		const { database, registry, pipeline, deliveries } = await openPipeline(
			join(directory, "gateway.db"),
			(eventId) => notes.get(eventId) ?? "fallback note",
		);
		const monitor = registry.add({
			name: "mixed-canonicalize",
			trigger: { kind: "cron", schedule: "* * * * *" },
			eventTypes: ["memory.canonicalize"],
		});
		const silent = pipeline.submit(monitor.monitorId, "memory.canonicalize", { i: 1 });
		const spoken = pipeline.submit(monitor.monitorId, "memory.canonicalize", { i: 2 });
		notes.set(silent, "[SILENT]");
		notes.set(spoken, "이슈 2건: 배포 큐 정체, 디스크 사용률 91%");
		await Bun.sleep(500);
		// Exactly one delivery, and its text contains ONLY the spoken note.
		const rows = database.deliveryRows();
		expect(rows).toHaveLength(1);
		const payload = JSON.parse(rows[0]!.payload_json) as { text: string };
		expect(payload.text).toContain("이슈 2건: 배포 큐 정체, 디스크 사용률 91%");
		expect(payload.text).not.toContain("[SILENT]");
		expect(deliveries).toHaveLength(1);
		expect((deliveries[0] as { text?: string }).text).not.toContain("[SILENT]");
		// The silent event of the SAME batch is terminal, not stuck on `authored`.
		const silentRow = database.monitorEventRows().find((row) => row.event_id === silent)!;
		expect(silentRow.stage).toBe("authored_no_delivery");
		expect(intentsFor(database, silent)).toBe(1);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a silent batch survives a restart: reconcile re-authors and re-delivers nothing (test d)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gajaeway-monitor-silence-d-"));
	try {
		const dbPath = join(directory, "gateway.db");
		const first = await openPipeline(dbPath, () => "[SILENT]");
		const monitor = first.registry.add({
			name: "restart-canonicalize",
			trigger: { kind: "cron", schedule: "* * * * *" },
			eventTypes: ["memory.canonicalize"],
		});
		const eventId = first.pipeline.submit(monitor.monitorId, "memory.canonicalize", {});
		await Bun.sleep(500);
		const outputBefore = first.database.authoredOutput(eventId);
		expect(outputBefore).toBe("[SILENT]");
		first.database.close();
		// A brand-new propagator over the SAME database file (the restart shape).
		const second = await openPipeline(dbPath, () => {
			throw new Error("reconcile must not re-author a settled silent event");
		});
		await second.pipeline.reconcile();
		// No new authoring turn, no new delivery, nothing rewritten.
		expect(second.prompts).toHaveLength(0);
		expect(second.deliveries).toHaveLength(0);
		expect(second.database.deliveryRows()).toHaveLength(0);
		const row = second.database.monitorEventRows().find((candidate) => candidate.event_id === eventId)!;
		expect(row.stage).toBe("authored_no_delivery");
		expect(second.database.authoredOutput(eventId)).toBe("[SILENT]");
		expect(intentsFor(second.database, eventId)).toBe(1);
		second.database.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("an instruction carrying the silence rule owns the audit prompt; the pass-report guidance stands down (test f)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gajaeway-monitor-silence-f-"));
	try {
		const { database, registry, pipeline, prompts } = await openPipeline(
			join(directory, "gateway.db"),
			() => "[SILENT]",
		);
		const instruction = "할 일이 없으면 note는 정확히 [SILENT] 한 토큰이다. 문제가 있으면 한국어 3줄 이내로 쓴다.";
		const monitor = registry.add({
			name: "quiet-audit",
			trigger: { kind: "cron", schedule: "0 4 * * *" },
			eventTypes: ["memory.audit"],
			instruction,
		});
		pipeline.submit(monitor.monitorId, "memory.audit", {});
		await Bun.sleep(500);
		const prompt = prompts[0]!;
		// The instruction is in the prompt, and the built-in that mandates a pass
		// report into the note is NOT — the two cannot both own the note.
		expect(prompt).toContain(instruction);
		expect(prompt).not.toContain("For memory.audit events:");
		// The receipt-note contract and response shape are unchanged.
		expect(prompt).toContain('{"eventId","note"}');
		// Mechanics-only built-in guidance for OTHER types is untouched.
		const canonicalize = registry.add({
			name: "quiet-canonicalize",
			trigger: { kind: "cron", schedule: "30 6 * * *" },
			eventTypes: ["memory.canonicalize"],
			instruction,
		});
		pipeline.submit(canonicalize.monitorId, "memory.canonicalize", {});
		await Bun.sleep(500);
		expect(prompts[1]).toContain(instruction);
		expect(prompts[1]).toContain("For memory.canonicalize events:");
		database.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

test("a monitor without an instruction keeps the exact pre-existing audit guidance (test f regression)", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gajaeway-monitor-silence-regression-"));
	try {
		const { database, registry, pipeline, prompts } = await openPipeline(
			join(directory, "gateway.db"),
			() => "검사 통과: 손상 0건",
		);
		const monitor = registry.add({
			name: "legacy-audit",
			trigger: { kind: "cron", schedule: "0 4 * * *" },
			eventTypes: ["memory.audit"],
		});
		pipeline.submit(monitor.monitorId, "memory.audit", {});
		await Bun.sleep(500);
		// No instruction: every built-in stays exactly as before.
		expect(prompts[0]).toContain("For memory.audit events:");
		expect(prompts[0]).toContain("put a one-line pass report");
		database.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
test("a pre-atomic crash artifact (authored + output + intent, silence note) settles on restart; spoken rows are untouched", async () => {
	const directory = await mkdtemp(join(tmpdir(), "gajaeway-monitor-silence-crash-"));
	try {
		const dbPath = join(directory, "gateway.db");
		// Seed the EXACT shape the old two-write path could leave after a crash
		// between the output+intent commit (stage `authored`) and the separate
		// terminal settle: a silent note stuck on the live `authored` stage.
		const seed = await GatewayDatabase.open(dbPath);
		const registry = new MonitorRegistry(seed);
		const monitor = registry.add({
			name: "crash-canonicalize",
			trigger: { kind: "cron", schedule: "* * * * *" },
			eventTypes: ["memory.canonicalize"],
		});
		const silentId = crypto.randomUUID();
		seed.monitorEventCreate({
			eventId: silentId,
			monitorId: monitor.monitorId,
			eventType: "memory.canonicalize",
			payloadJson: "{}",
			firedAt: new Date().toISOString(),
		});
		seed.monitorEventUpdate(silentId, "authored", "batch-crash");
		seed.authoredOutputCreate(silentId, "[SILENT]");
		seed.memoryIntentCreate({
			id: `monitor-event-intent:${silentId}`,
			kind: "monitor-event",
			payloadJson: JSON.stringify({
				kind: "monitor-event",
				identity: `monitor-event:${silentId}`,
				originRefJson: "{}",
				userText: `Monitor event ${silentId}: memory.canonicalize`,
				replyText: "[SILENT]",
			}),
		});
		// A spoken `authored` row in the same shape must NOT be settled by the
		// repair: it belongs to the delivery path, not the silence rule.
		const spokenId = crypto.randomUUID();
		seed.monitorEventCreate({
			eventId: spokenId,
			monitorId: monitor.monitorId,
			eventType: "memory.canonicalize",
			payloadJson: "{}",
			firedAt: new Date().toISOString(),
		});
		seed.monitorEventUpdate(spokenId, "authored", "batch-crash");
		seed.authoredOutputCreate(spokenId, "이슈 1건: 디스크 91%");
		seed.memoryIntentCreate({
			id: `monitor-event-intent:${spokenId}`,
			kind: "monitor-event",
			payloadJson: JSON.stringify({
				kind: "monitor-event",
				identity: `monitor-event:${spokenId}`,
				originRefJson: "{}",
				userText: `Monitor event ${spokenId}: memory.canonicalize`,
				replyText: "이슈 1건: 디스크 91%",
			}),
		});
		seed.close();
		// Restart shape: brand-new propagator over the same file.
		const second = await openPipeline(dbPath, () => {
			throw new Error("reconcile must not re-author a crash-settled silent event");
		});
		await second.pipeline.reconcile();
		const silentRow = second.database.monitorEventRows().find((row) => row.event_id === silentId)!;
		expect(silentRow.stage).toBe("authored_no_delivery");
		expect(second.database.deliveryRows()).toHaveLength(0);
		expect(second.database.authoredOutput(silentId)).toBe("[SILENT]");
		expect(intentsFor(second.database, silentId)).toBe(1);
		const spokenRow = second.database.monitorEventRows().find((row) => row.event_id === spokenId)!;
		expect(spokenRow.stage).toBe("authored");
		expect(second.prompts).toHaveLength(0);
		second.database.close();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
