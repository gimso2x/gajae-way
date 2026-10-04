import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CliRunner } from "@gajae-gateway/subsession";
import { BrokerSessionPort } from "../src/orchestrator/session-port";
import { TailRunner } from "../src/orchestrator/tail-runner";
import { GatewayDatabase } from "../src/store/db";
import { noRelay } from "./session-port.fake";

test("an uncertain session-create retries its original key and epoch without overlapping a host", async () => {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-create-epoch-"));
	const database = await GatewayDatabase.open(join(home, "gateway.db"));
	const authority = { canonicalAgentDir: home, identity: `gjc:${home}` };
	database.assertBrokerAuthority(authority, { initializeEmpty: true });
	let creates = 0;
	const keys: string[] = [];
	const inputs: Array<Record<string, unknown>> = [];
	const run: CliRunner = async (args) => {
		if (args.includes("session.create")) {
			creates++;
			keys.push(args[args.indexOf("--idempotency-key") + 1]!);
			inputs.push(JSON.parse(args[args.indexOf("--json-input") + 1]!) as Record<string, unknown>);
			if (creates <= 5)
				return {
					exitCode: 1,
					stdout: JSON.stringify({
						ok: false,
						error: { code: "terminal_uncertain", message: "startup did not complete" },
					}),
					stderr: "",
				};
			return {
				exitCode: 0,
				stdout: JSON.stringify({ ok: true, result: { sessionId: "fresh-session" } }),
				stderr: "",
			};
		}
		if (args.includes("inspect"))
			return {
				exitCode: 0,
				stdout: JSON.stringify({
					ok: true,
					result: { session: { sessionId: "fresh-session", live: true, locator: { cwd: join(home, "workspace") } } },
				}),
				stderr: "",
			};
		throw new Error(`unexpected command ${args.join(" ")}`);
	};
	const port = new BrokerSessionPort({
		database,
		authority,
		cli: run,
		instanceId: "create-epoch",
		tailRunner: new TailRunner({ stream: noRelay, repo: join(home, "workspace") }),
		sleep: async () => {},
	});
	try {
		await expect(
			port.bind({
				originKey: "monitor/eventtype/memory.canonicalize",
				epoch: 0,
				repo: join(home, "workspace"),
				model: { preset: "gpt-heavy" },
			}),
		).rejects.toMatchObject({ details: { code: "terminal_uncertain" } });
		expect(database.getSessionRecord("monitor/eventtype/memory.canonicalize")).toBeUndefined();
		const binding = await port.bind({
			originKey: "monitor/eventtype/memory.canonicalize",
			epoch: 0,
			repo: join(home, "workspace"),
			model: { preset: "gpt-heavy" },
		});
		expect(creates).toBe(6);
		expect(new Set(keys).size).toBe(1);
		expect(binding).toMatchObject({ sessionId: "fresh-session", epoch: 0, startupModelApplied: true });
		expect(database.getSessionRecord("monitor/eventtype/memory.canonicalize")).toMatchObject({
			epoch: 0,
			sessionId: "fresh-session",
		});
		expect(inputs.every((input) => input.modelPreset === "gpt-heavy")).toBe(true);
	} finally {
		database.close();
		await rm(home, { recursive: true, force: true });
	}
});
