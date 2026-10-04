import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeliveryService } from "../src/delivery/delivery";
import type { PersonaRecoveryHoldInput } from "../src/orchestrator/persona-session";
import { reportRecoveryHold } from "../src/server/server";
import { GatewayDatabase } from "../src/store/db";
import { DeliveryLedger } from "../src/store/ledger";

const OWNER = { platform: "slack", kind: "dm", conversationId: "D-owner", peerId: "U-owner" } as const;
let home = "";
let database: GatewayDatabase | undefined;

afterEach(async () => {
	database?.close();
	database = undefined;
	if (home) await rm(home, { recursive: true, force: true });
	home = "";
});

async function runtime(ownerTarget: boolean) {
	home = await mkdtemp(join(tmpdir(), "gajaeway-hold-notice-"));
	database = await GatewayDatabase.open(join(home, "gateway.db"));
	const written: Array<{ event: string; payload: { deliveryId: string; origin: unknown; text: string } }> = [];
	const adapter = { negotiated: true, write: (frame: never) => written.push(frame) };
	return {
		written,
		ledger: new DeliveryLedger(database),
		rt: {
			config: ownerTarget ? { ownerTarget: { origin: OWNER } } : {},
			delivery: new DeliveryService(new DeliveryLedger(database)),
			connections: new Set([adapter]),
		} as never,
	};
}

const hold = (opRef: string): PersonaRecoveryHoldInput => ({
	originKey: "slack/channel/C1",
	opRef,
	epoch: 2,
	reason: "operation state terminal_uncertain is not decidable; do not resend, resume or recreate",
	sweeps: 5,
	trigger: { body: "@PM   stuck\nquestion" } as never,
});

test("a persistent recovery hold reaches the owner DM once, deduplicated by op-ref across calls", async () => {
	const { written, ledger, rt } = await runtime(true);
	reportRecoveryHold(rt, hold("gw-p-aaa"));
	expect(written).toHaveLength(1);
	const payload = written[0]!.payload;
	expect(written[0]!.event).toBe("chat.message");
	expect(payload.origin).toEqual(OWNER);
	expect(payload.deliveryId).toMatch(/^gw-x-[0-9a-f]{32}$/);
	expect(payload.text).toContain("[recovery hold] slack/channel/C1");
	expect(payload.text).toContain("조회 5회");
	expect(payload.text).not.toContain("분째");
	expect(payload.text).toContain("/new는 기존 작업을 복구하거나 완료하지 않습니다");
	expect(payload.text).toContain("같은 요청을 다시 보내거나 대기 기록을 삭제하지 마세요");
	expect(payload.text).toContain('메시지: "@PM stuck question"');
	expect(payload.text).toContain("gw-p-aaa");
	expect(payload.text).toContain("자동 재전송은 하지 않습니다");
	expect(ledger.get(payload.deliveryId)?.state).toBe("inflight");

	// A restart re-counts sweeps and escalates again: the ledger id is the same, so nothing new is sent.
	reportRecoveryHold(rt, hold("gw-p-aaa"));
	expect(written).toHaveLength(1);

	reportRecoveryHold(rt, hold("gw-p-bbb"));
	expect(written).toHaveLength(2);
	expect(written[1]!.payload.deliveryId).not.toBe(payload.deliveryId);
});

test("without an ownerTarget a recovery hold sends nothing", async () => {
	const { written, ledger, rt } = await runtime(false);
	reportRecoveryHold(rt, hold("gw-p-aaa"));
	expect(written).toEqual([]);
	expect(ledger.counts().pending).toBe(0);
});
