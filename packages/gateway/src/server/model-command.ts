import { join } from "node:path";
import type { GjcModelSelection } from "../store/db";

/** The store surface `/model` needs; narrowed so tests need no real database. */
export interface ModelOverrideStore {
	conversationModelGet(originKey: string): { readonly selection: GjcModelSelection } | undefined;
	conversationModelSet(originKey: string, selection: GjcModelSelection, setBy?: string): void;
	conversationModelClear(originKey: string): boolean;
}

export type ModelRebindIntent =
	| { readonly kind: "set"; readonly selection: GjcModelSelection }
	| { readonly kind: "clear" };

/**
 * The selectable-model catalog `/model list` renders. The gateway reads it
 * from the configured gjc source; `error` reports why no list is available.
 */
export type ModelCatalog =
	| {
			readonly source: string;
			readonly includesPresets: boolean;
			readonly models: readonly ModelListEntry[];
	  }
	| { readonly error: string };

export interface ModelListEntry {
	/** Explicit `provider/model` selector, exactly what `/model set <selector>` accepts. */
	readonly selector: string;
	/** Human model name from the gjc catalog; falls back to the selector when unnamed. */
	readonly label: string;
}

/** How many selectors the human-readable `/model list` text previews before "+N more". */
const LIST_PREVIEW_COUNT = 15;

export interface ModelCommandOutcome {
	readonly text: string;
	/** A same-session control transition the per-origin actor must serialize. */
	readonly rebind?: ModelRebindIntent;
}

/**
 * `/model set` autocomplete choices: the preset names in the gjc profile's
 * `models.yml` `profiles:` map, plus the configured gateway selector. Fails soft
 * to whatever could be read: a missing or unreadable models file must not break
 * the command, because a typed choice is still accepted.
 */
export async function listModelChoices(
	agentDir: string | undefined,
	configModel: GjcModelSelection | undefined,
): Promise<string[]> {
	const choices = new Set<string>();
	if (configModel) choices.add(typeof configModel === "string" ? configModel : configModel.preset);
	if (agentDir) {
		try {
			const parsed = Bun.YAML.parse(await Bun.file(join(agentDir, "models.yml")).text()) as unknown;
			const profiles = (parsed as { profiles?: unknown } | null)?.profiles;
			if (profiles && typeof profiles === "object" && !Array.isArray(profiles))
				for (const name of Object.keys(profiles)) choices.add(name);
		} catch {
			// Fail soft: no catalog means no suggestions, never a broken command.
		}
	}
	// A name with whitespace could never round-trip through `/model set <choice>`.
	return [...choices].filter((choice) => choice !== "" && !/\s/.test(choice)).sort();
}

/** Renders a selection the way the owner typed it. */
export function describeSelection(selection: GjcModelSelection): string {
	return typeof selection === "string" ? selection : `preset ${selection.preset}`;
}

/**
 * Parses a `/model` argument into a selection. A bare token containing `/` is
 * treated as an explicit provider selector; anything else is a preset name,
 * which is what a slash-command choice supplies. `preset:` and `model:`
 * prefixes force the interpretation when a name is ambiguous.
 */
export function parseModelArgument(argument: string): GjcModelSelection | { readonly error: string } {
	const raw = argument.trim();
	if (raw === "") return { error: "empty selection" };
	if (/\s/.test(raw)) return { error: "a selection cannot contain spaces" };
	const forcedPreset = /^preset:(.+)$/.exec(raw);
	if (forcedPreset?.[1]) return { preset: forcedPreset[1] };
	const forcedModel = /^model:(.+)$/.exec(raw);
	if (forcedModel?.[1]) return forcedModel[1];
	return raw.includes("/") ? raw : { preset: raw };
}

/**
 * Executes `/model`, `/model list`, `/model <choice>`, `/model set <choice>`
 * or `/model clear`. A change returns a same-session rebind intent; the actor
 * applies it through `model.set` without changing the conversation epoch.
 * `catalog` is consulted only by `/model list`.
 */
export function applyModelCommand(
	text: string,
	originKey: string,
	origin: { readonly platform: string },
	store: ModelOverrideStore,
	configModel: GjcModelSelection | undefined,
	setBy?: string,
	catalog?: ModelCatalog,
): ModelCommandOutcome {
	const rest = text.slice("/model".length).trim();
	const [head = "", ...tail] = rest.split(/\s+/).filter((part) => part !== "");
	const showEffective = (): string => {
		const override = store.conversationModelGet(originKey)?.selection;
		if (override) return `🦞 model: **${describeSelection(override)}** (this conversation)`;
		if (configModel) return `🦞 model: **${describeSelection(configModel)}** (gateway default)`;
		return "🦞 model: **gjc default** (no gateway setting, no conversation override)";
	};

	if (rest === "" || head === "show") return { text: showEffective() };

	if (head === "list") {
		if (!catalog || "error" in catalog)
			return {
				text: `🦞 the selectable model list is unavailable${catalog && "error" in catalog ? ` (${catalog.error})` : ""}. ${showEffective()}`,
			};
		const preview = catalog.models
			.slice(0, LIST_PREVIEW_COUNT)
			.map((entry) => entry.selector)
			.join(", ");
		const more =
			catalog.models.length > LIST_PREVIEW_COUNT ? ` … +${catalog.models.length - LIST_PREVIEW_COUNT} more` : "";
		const presets = catalog.includesPresets
			? "presets included"
			: "presets excluded (gjc model profiles are not enumerable here; force one with `/model set preset:<name>`)";
		return {
			text: `🦞 selectable models — ${catalog.models.length} from ${catalog.source}; ${presets}: ${preview}${more}. ${showEffective()}`,
		};
	}

	if (head === "clear" || head === "reset" || head === "default") {
		const existing = store.conversationModelGet(originKey)?.selection;
		if (!existing) return { text: `no conversation override to clear. ${showEffective()}` };
		if (!configModel)
			return {
				text: "cannot live-clear this override because no gateway default model is configured. Set a gateway model or choose an explicit model instead.",
			};
		store.conversationModelClear(originKey);
		return {
			text: `🦞 cleared this conversation's override. ${showEffective()} The model applies from the next turn on this same session.`,
			rebind: { kind: "clear" },
		};
	}

	const argument = head === "set" ? tail.join(" ") : rest;
	const parsed = parseModelArgument(argument);
	if (typeof parsed !== "string" && "error" in parsed)
		return {
			text: `could not read that selection (${parsed.error}). usage: \`/model\`, \`/model list\`, \`/model set <preset-or-selector>\`, \`/model clear\``,
		};
	store.conversationModelSet(originKey, parsed, setBy);
	const scope = origin.platform === "loopback" ? "this session" : "this conversation";
	return {
		text: `🦞 model set to **${describeSelection(parsed)}** for ${scope}. It applies from the next turn on this same session.`,
		rebind: { kind: "set", selection: parsed },
	};
}
