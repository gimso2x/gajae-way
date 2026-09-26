import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { ModelCatalog } from "./model-command";

/**
 * The gjc-maintained model catalog the picker reads. gjc derives it from the
 * `providers:` section of `~/.gjc/agent/models.yml` and keeps the parsed,
 * credential-free snapshot fresh (per-provider `models` JSON blobs, refreshed
 * whenever the gjc CLI or SDK touches providers). It is the one machine-readable
 * surface for "what can `/model set` select": `models.yml` needs a YAML parser
 * and embeds provider API keys, and `gjc models` prints two incompatible human
 * table layouts with no `--json`.
 */
const CATALOG_SOURCE = "gjc models.db";

/** Model-profile presets are gjc's merged catalog (built-in + models.yml); not enumerated here. */
const INCLUDES_PRESETS = false;

/** A memoized catalog lives this long; the picker is human-paced and models.yml edits are rare. */
const CATALOG_TTL_MS = 60_000;

interface CacheSlot {
	readonly agentDir: string;
	readonly at: number;
	readonly catalog: ModelCatalog;
}
let cache: CacheSlot | undefined;

/** Forgets the memoized catalog; tests use this to isolate agent directories. */
export function resetModelCatalogCache(): void {
	cache = undefined;
}

/**
 * Reads the selectable `provider/model` selectors from `<agentDir>/models.db`.
 * A missing or unreadable catalog is an explicit `error`, never a hardcoded
 * fallback: the picker must not offer a model the user's gjc cannot resolve.
 */
export function readModelCatalog(
	agentDir: string | undefined,
	deps: { readonly now?: () => number; readonly ttlMs?: number } = {},
): ModelCatalog {
	if (!agentDir) return { error: "no gjc agent directory is configured" };
	const now = deps.now ?? Date.now;
	if (cache && cache.agentDir === agentDir && now() - cache.at < (deps.ttlMs ?? CATALOG_TTL_MS)) return cache.catalog;
	const catalog = readModelCatalogUncached(agentDir);
	cache = { agentDir, at: now(), catalog };
	return catalog;
}

function readModelCatalogUncached(agentDir: string): ModelCatalog {
	const path = join(agentDir, "models.db");
	let database: Database;
	try {
		database = new Database(path, { readonly: true });
	} catch (error) {
		return { error: `${path} could not be opened (${errorText(error)})` };
	}
	try {
		const rows = database
			.query<{ provider_id: string; models: string }, []>("SELECT provider_id, models FROM model_cache")
			.all();
		const models = new Map<string, { selector: string; label: string }>();
		for (const row of rows) {
			if (/\s/.test(row.provider_id) || row.provider_id === "") continue;
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.models);
			} catch {
				continue; // A torn cache row only shrinks the list; it never fabricates entries.
			}
			if (!Array.isArray(parsed)) continue;
			for (const entry of parsed) {
				if (typeof entry !== "object" || entry === null) continue;
				const id = (entry as Record<string, unknown>).id;
				// A selector with a slash is a malformed nested id, and whitespace could
				// never survive the /model set parse: both would advertise an
				// unselectable entry, so they shrink the list instead.
				if (typeof id !== "string" || id === "" || /\s/.test(id) || id.includes("/")) continue;
				const selector = `${row.provider_id}/${id}`;
				if (models.has(selector)) continue;
				const name = (entry as Record<string, unknown>).name;
				models.set(selector, {
					selector,
					label: typeof name === "string" && name.trim() !== "" ? name.trim() : selector,
				});
			}
		}
		const list = [...models.values()].sort((a, b) => (a.selector < b.selector ? -1 : a.selector > b.selector ? 1 : 0));
		return { source: CATALOG_SOURCE, includesPresets: INCLUDES_PRESETS, models: list };
	} catch (error) {
		return { error: `${path} could not be read (${errorText(error)})` };
	} finally {
		database.close();
	}
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
