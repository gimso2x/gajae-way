export const ENGAGEMENT_MODES = ["open", "lead", "mention-open", "closed"] as const;
export type EngagementMode = (typeof ENGAGEMENT_MODES)[number];

export const ENGAGEMENT_AUDIENCES = ["all", "human-only", "bot-only"] as const;
export type EngagementAudience = (typeof ENGAGEMENT_AUDIENCES)[number];

/** Per-channel engagement policy shared by gateway and platform adapters. */
export interface ChannelEngagementPolicy {
	/** Unset remains the safe `closed` gateway default. */
	readonly engagement?: EngagementMode;
	/** Unset preserves historical `open` behavior: humans use the mode, bots use the closed gate. */
	readonly audience?: EngagementAudience;
}

export interface ChannelEngagementInput {
	readonly policy?: ChannelEngagementPolicy;
	readonly authorIsBot: boolean;
	/** A real platform mention or a native reply addressed to this bot/session. */
	readonly addressed: boolean;
	/** The message sits at the top level of the channel, not inside a thread. Only `lead` reads it. */
	readonly topLevel?: boolean;
	/** The text mentions some other account and not this one. Only `lead` reads it. */
	readonly mentionsOthers?: boolean;
	/** Existing owner/allowlist authorization used by the closed gate. */
	readonly authorized: boolean;
}

export interface ChannelEngagementDecision {
	readonly engaged: boolean;
	/** True only when a bot was admitted by an explicitly widened audience rather than the closed gate. */
	readonly botAudienceAdmission: boolean;
}

/**
 * Canonical channel policy evaluation.
 *
 * An explicit `human-only`/`bot-only` audience is a strict exclusion filter:
 * authors outside the audience are declined, never routed to the closed gate.
 * An omitted audience preserves legacy behavior: humans use the mode while
 * bots fall back to the closed mention-and-allowlist gate. `closed` always
 * ignores audience and uses the closed gate for every author.
 *
 * `lead` is for the default responder of a room shared with other personas:
 * top-level HUMAN messages are turns without addressing unless they mention
 * some other account and not this one, while threads need addressing (a
 * mention, a native reply, or a thread this persona is already answering)
 * exactly like `mention-open`. A thread it has no part in belongs to whoever
 * is answering it. A bot author never rides the unaddressed turn: its
 * unmentioned posts are ambient room noise and reach a lead persona only
 * through an explicit mention in the text.
 */
export function evaluateChannelEngagement(input: ChannelEngagementInput): ChannelEngagementDecision {
	const mode = input.policy?.engagement ?? "closed";
	const audience = input.policy?.audience;
	if (mode === "closed") {
		return { engaged: input.addressed && input.authorized, botAudienceAdmission: false };
	}
	const unaddressedTurn =
		mode === "open" ||
		// A bot's unmentioned top-level post is not the lead persona's turn to
		// take: sibling personas post receipts and chatter all the time, and
		// only an explicit mention aims a bot message at this one.
		(mode === "lead" && input.authorIsBot !== true && input.topLevel === true && input.mentionsOthers !== true);
	if (audience === "bot-only" || audience === "human-only") {
		const audienceMatches = audience === "bot-only" ? input.authorIsBot : !input.authorIsBot;
		if (!audienceMatches) return { engaged: false, botAudienceAdmission: false };
		const engaged = unaddressedTurn || input.addressed;
		return { engaged, botAudienceAdmission: engaged && input.authorIsBot };
	}
	if (audience === "all") {
		const engaged = unaddressedTurn || input.addressed;
		return { engaged, botAudienceAdmission: engaged && input.authorIsBot };
	}
	// No explicit audience: humans use the mode, bots use the closed gate.
	if (input.authorIsBot) {
		return { engaged: input.addressed && input.authorized, botAudienceAdmission: false };
	}
	return { engaged: unaddressedTurn || input.addressed, botAudienceAdmission: false };
}
