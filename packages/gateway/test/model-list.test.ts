import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayConfig } from "../src/config";
import type { ModelCatalog } from "../src/server/model-command";
import { readModelCatalog, resetModelCatalogCache } from "../src/server/model-list";
import { type GatewayServer, startUnixServer } from "../src/server/server";
import { GatewayDatabase } from "../src/store/db";
import { attachTestBrokerOwnership, ScriptedSessionPort } from "./session-port.fake";

beforeEach(() => {
	// The catalog is memoized per agent directory; tests must not observe each other.
	resetModelCatalogCache();
});

function writeCatalogDb(home: string, rows: readonly { provider: string; models: unknown }[]): void {
	const db = new Database(join(home, "models.db"));
	db.exec(`CREATE TABLE IF NOT EXISTS model_cache (
		provider_id TEXT PRIMARY KEY,
		version INTEGER NOT NULL,
		updated_at INTEGER NOT NULL,
		authoritative INTEGER NOT NULL DEFAULT 0,
		static_fingerprint TEXT NOT NULL DEFAULT '',
		models TEXT NOT NULL,
		dynamic_model_ids TEXT,
		dynamic_model_provenance TEXT
	)`);

	db.exec("DELETE FROM model_cache");
	const insert = db.query(
		"INSERT OR REPLACE INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, models) VALUES (?, 5, 0, 1, '', ?)",
	);
	// A raw string is stored verbatim so a test can plant genuinely torn JSON.
	for (const row of rows)
		insert.run(row.provider, typeof row.models === "string" ? row.models : JSON.stringify(row.models));
	db.close();
}

test("the picker catalog reads provider/model selectors from gjc's own cache", async () => {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-model-list-catalog-"));
	try {
		writeCatalogDb(home, [
			{
				provider: "openai",
				models: [{ id: "gpt-5.2", name: "GPT-5.2" }, { id: "gpt-5.2-mini" }],
			},
			{ provider: "zai", models: [{ id: "glm-5.3", name: "GLM-5.3" }] },
		]);
		const catalog = readModelCatalog(home, { ttlMs: 0 });
		expect(catalog).toEqual({
			source: "gjc models.db",
			includesPresets: false,
			models: [
				{ selector: "openai/gpt-5.2", label: "GPT-5.2" },
				{ selector: "openai/gpt-5.2-mini", label: "openai/gpt-5.2-mini" },
				{ selector: "zai/glm-5.3", label: "GLM-5.3" },
			],
		});
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("torn cache rows and malformed entries shrink the list instead of breaking it", async () => {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-model-list-torn-"));
	try {
		writeCatalogDb(home, [
			{ provider: "broken", models: "{not json" },
			{ provider: "empty", models: [] },
			{ provider: "nullish", models: null },
			{
				provider: "openai",
				models: [
					{ id: "gpt-5.2", name: "GPT-5.2" },
					{ id: "" },
					{ id: "no/slash" },
					"not-an-object",
					{ id: "has space" },
					null,
					{ name: "unnamed" },
				],
			},
			{ provider: "bad provider", models: [{ id: "glm" }] },
		]);
		const catalog = readModelCatalog(home, { ttlMs: 0 });
		expect(catalog).toEqual({
			source: "gjc models.db",
			includesPresets: false,
			models: [{ selector: "openai/gpt-5.2", label: "GPT-5.2" }],
		});
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a missing catalog is an explicit error, never a hardcoded list", async () => {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-model-list-missing-"));
	try {
		const catalog = readModelCatalog(home, { ttlMs: 0 });
		expect(catalog).toMatchObject({ error: expect.stringContaining("models.db") });
		expect("models" in catalog).toBe(false);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

test("a missing agent directory is an explicit error", () => {
	expect(readModelCatalog(undefined, { ttlMs: 0 })).toEqual({ error: "no gjc agent directory is configured" });
});

test("the catalog is memoized per agent directory within the TTL", async () => {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-model-list-cache-"));
	try {
		writeCatalogDb(home, [{ provider: "openai", models: [{ id: "gpt-5.2" }] }]);
		const first = readModelCatalog(home);
		expect(first).toMatchObject({ models: [{ selector: "openai/gpt-5.2" }] });
		writeCatalogDb(home, [{ provider: "zai", models: [{ id: "glm-5.3" }] }]);
		expect(readModelCatalog(home)).toMatchObject({ models: [{ selector: "openai/gpt-5.2" }] });
		expect(readModelCatalog(home, { ttlMs: 0 })).toMatchObject({ models: [{ selector: "zai/glm-5.3" }] });
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	for (let attempt = 0; attempt < 300; attempt++) {
		if (predicate()) return;
		await Bun.sleep(5);
	}
	expect(predicate(), message).toBe(true);
}

test("/model list answers with the structured catalog and text in the chat.send response", async () => {
	const home = await mkdtemp(join(tmpdir(), "gajaeway-model-list-server-"));
	const config: GatewayConfig = {
		schemaVersion: 1,
		home,
		configPath: join(home, "config.json"),
		socketPath: join(home, "gateway.sock"),
		dbPath: join(home, "gateway.db"),
		logVerbosity: "info",
	};
	const database = await GatewayDatabase.open(config.dbPath);
	const port = new ScriptedSessionPort();
	attachTestBrokerOwnership(database, port, join(home, "agent"));
	const catalog: ModelCatalog = {
		source: "gjc models.db",
		includesPresets: false,
		models: [
			{ selector: "openai/gpt-5.2", label: "GPT-5.2" },
			{ selector: "zai/glm-5.3", label: "GLM-5.3" },
		],
	};
	let server: GatewayServer | undefined;
	let client: { send(value: unknown): void; end(): void } | undefined;
	const frames: { type?: string; result?: Record<string, unknown> }[] = [];
	try {
		server = await startUnixServer({
			config,
			database,
			sessionPort: port,
			onStop: () => database.close(),
			modelCatalog: () => catalog,
		});
		const socket = await Bun.connect({
			unix: config.socketPath,
			socket: {
				data(_socket, data) {
					for (const line of String(data).split("\n")) {
						if (line.trim() === "") continue;
						try {
							frames.push(JSON.parse(line));
						} catch {
							// A frame split across reads is re-parsed on its completion.
						}
					}
				},
			},
		});
		client = { send: (value) => socket.write(`${JSON.stringify(value)}\n`), end: () => socket.end() };
		client.send({ v: "0.1", type: "hello", payload: { supportedVersions: ["0.1"] } });
		await Bun.sleep(5);
		const origin = { platform: "loopback", kind: "loopback", conversationId: "list" };
		client.send({
			v: "0.1",
			type: "request",
			id: "list",
			verb: "chat.send",
			params: { origin, messageId: "m-list", text: "/model list" },
		});
		await waitFor(() => frames.some((frame) => frame.type === "response"), "model list response never arrived");
		const response = frames.filter((frame) => frame.type === "response").at(-1)?.result as {
			engaged: boolean;
			text: string;
			modelList: {
				source: string;
				includesPresets: boolean;
				current: string;
				models: readonly { selector: string; label: string }[];
			};
		};
		expect(response.engaged).toBe(true);
		expect(response.text).toContain("gjc models.db");
		expect(response.modelList).toMatchObject({
			source: "gjc models.db",
			includesPresets: false,
			current: "gjc default",
		});
		expect(response.modelList.models).toEqual(catalog.models);

		// The loopback event for the same turn carries the source message id, so an
		// interactive consumer can correlate its ephemerally-answered request.
		const event = frames.find(
			(frame) =>
				frame.type === "event" &&
				(frame as { event?: string; payload?: { sourceMessageId?: string } }).event === "chat.message",
		) as { payload?: { sourceMessageId?: string } } | undefined;
		expect(event?.payload?.sourceMessageId).toBe("m-list");

		// An ordinary `/model` read answers with text only; the catalog is list-only.
		client.send({
			v: "0.1",
			type: "request",
			id: "show",
			verb: "chat.send",
			params: { origin, text: "/model" },
		});
		await waitFor(
			() => frames.filter((frame) => frame.type === "response").length >= 2,
			"model show response never arrived",
		);
		const show = frames.filter((frame) => frame.type === "response").at(-1)?.result as {
			text: string;
			modelList?: unknown;
		};
		expect(show.text).toContain("gjc default");
		expect(show.modelList).toBeUndefined();
	} finally {
		client?.end();
		try {
			await server?.stop();
		} finally {
			if (!server) database.close();
			await rm(home, { recursive: true, force: true });
		}
	}
});
