import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { childEnvironment, GlobalGjcClient, type SpawnFn } from "../src/orchestrator/broker";
import { GjcClient } from "../src/orchestrator/gjc-client";
import { GatewayDatabase } from "../src/store/db";

const LEAK = "/tmp/gajaeway-home-that-must-not-leak";
const hostHome = process.env.HOME ?? "";
const hostPath = process.env.PATH ?? "";

/** Sets the leaking variable for the duration of a spawn-path check. */
function withLeak(): () => void {
	const previous = process.env.GAJAEWAY_HOME;
	process.env.GAJAEWAY_HOME = LEAK;
	return () => {
		if (previous === undefined) delete process.env.GAJAEWAY_HOME;
		else process.env.GAJAEWAY_HOME = previous;
	};
}

function child(stdout: string, stderr = "", exitCode = 0): ReturnType<typeof Bun.spawn> {
	return {
		stdout: new Response(stdout).body,
		stderr: new Response(stderr).body,
		exited: Promise.resolve(exitCode),
		kill: () => {},
	} as unknown as ReturnType<typeof Bun.spawn>;
}

test("childEnvironment drops only GAJAEWAY_HOME", () => {
	expect(
		childEnvironment({
			HOME: "/home/operator",
			PATH: "/usr/bin:/bin",
			GAJAEWAY_HOME: LEAK,
			GJC_CONFIG_DIR: "/home/operator/.gjc",
			GJC_CODING_AGENT_DIR: "/home/operator/.gjc/agent",
			EMPTY: undefined,
		}),
	).toEqual({
		HOME: "/home/operator",
		PATH: "/usr/bin:/bin",
		GJC_CONFIG_DIR: "/home/operator/.gjc",
		GJC_CODING_AGENT_DIR: "/home/operator/.gjc/agent",
	});
});

test("session.create spawns gjc without GAJAEWAY_HOME and with HOME/PATH intact", async () => {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-env-session-"));
	const database = await GatewayDatabase.open(join(home, "gateway.db"));
	try {
		const spawned: Array<Record<string, string>> = [];
		const spawn = ((options: { env: Record<string, string> }) => {
			spawned.push(options.env);
			return child(`${JSON.stringify({ ok: true, result: { sessionId: "session-env" } })}\n`);
		}) as unknown as typeof Bun.spawn;
		const restore = withLeak();
		try {
			const client = new GjcClient(database, home, { spawn, log: () => {} });
			await client.ensureSession("discord/dm/env", 0);
		} finally {
			restore();
		}
		expect(spawned).toHaveLength(1);
		expect(spawned[0]!.GAJAEWAY_HOME).toBeUndefined();
		expect(spawned[0]!.HOME).toBe(hostHome);
		expect(spawned[0]!.PATH).toBe(hostPath);
	} finally {
		database.close();
		await rm(home, { recursive: true, force: true });
	}
});

test("broker CLI and relay children get an environment without GAJAEWAY_HOME", async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), "gajaeway-env-broker-")));
	const invocations: Array<{ cmd: string[]; env: Record<string, string> }> = [];
	const spawn = ((options: { cmd: string[]; env: Record<string, string> }) => {
		invocations.push(options);
		return {
			exited: Promise.resolve(0),
			stdout: new Blob([JSON.stringify({ ok: true, result: { sessions: [] } })]).stream(),
			stderr: new Blob([]).stream(),
			kill() {},
		};
	}) as unknown as SpawnFn;
	let client: GlobalGjcClient | undefined;
	const restore = withLeak();
	try {
		client = new GlobalGjcClient({
			executable: "/fake/nondefault/bin/gjc",
			agentDir: root,
			spawn,
			command: undefined,
			discovery: async () => ({ pid: 12345, url: "ws://127.0.0.1:12345", token: "fake", heartbeatAt: Date.now() }),
			healthProbe: async () => true,
			log: () => {},
		});
		await client.start();
		await client.cli(["sdk", "session", "list", "--scope", "all"]);
		const stream = client.openStream("owned-session");
		for await (const _line of stream.lines) {
			/* drain fake relay */
		}
	} finally {
		restore();
		await client?.stop().catch(() => {});
		await rm(root, { recursive: true, force: true });
	}
	// One CLI child and one relay child: both spawn sites of the broker client.
	expect(invocations).toHaveLength(2);
	for (const invocation of invocations) {
		expect(invocation.env.GAJAEWAY_HOME).toBeUndefined();
		expect(invocation.env.HOME).toBe(hostHome);
		expect(invocation.env.PATH).toBe(hostPath);
	}
});
