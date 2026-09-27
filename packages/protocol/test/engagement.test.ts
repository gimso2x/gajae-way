import { describe, expect, test } from "bun:test";
import { evaluateChannelEngagement } from "../src/index";

/**
 * The canonical lead-mode gates, mirrored at the gateway layer by
 * `engagement-policy.test.ts` and end to end by `lead-bot-ambient.test.ts`.
 * A bot's unmentioned top-level post is ambient room noise in a lead channel:
 * only an explicit mention aims a bot message at the lead persona.
 */

const lead = (audience: "all" | "bot-only" | "human-only") => ({
	policy: { engagement: "lead" as const, audience },
	authorized: false,
});
const open = (audience: "all" | "bot-only") => ({
	policy: { engagement: "open" as const, audience },
	authorized: false,
});

describe("lead mode ignores a bot's unmentioned top-level posts", () => {
	test("lead+all: a bot's unmentioned top-level post is not a turn; a mention is", () => {
		expect(evaluateChannelEngagement({ ...lead("all"), authorIsBot: true, addressed: false, topLevel: true })).toEqual({
			engaged: false,
			botAudienceAdmission: false,
		});
		expect(evaluateChannelEngagement({ ...lead("all"), authorIsBot: true, addressed: true, topLevel: true })).toEqual({
			engaged: true,
			botAudienceAdmission: true,
		});
	});

	test("lead+bot-only: same gate as all — mention or nothing", () => {
		expect(
			evaluateChannelEngagement({ ...lead("bot-only"), authorIsBot: true, addressed: false, topLevel: true }),
		).toEqual({ engaged: false, botAudienceAdmission: false });
		expect(
			evaluateChannelEngagement({ ...lead("bot-only"), authorIsBot: true, addressed: true, topLevel: true }),
		).toEqual({ engaged: true, botAudienceAdmission: true });
	});

	test("a thread reply from a bot never engages, thread follow-up inheritance included", () => {
		// Threads need addressing on every author; a bot is never granted the
		// thread follow-up, so an unmentioned bot reply stays ambient even in a
		// thread the persona is already answering.
		expect(evaluateChannelEngagement({ ...lead("all"), authorIsBot: true, addressed: false })).toEqual({
			engaged: false,
			botAudienceAdmission: false,
		});
		expect(
			evaluateChannelEngagement({ ...lead("all"), authorIsBot: true, addressed: false, mentionsOthers: true }),
		).toEqual({ engaged: false, botAudienceAdmission: false });
	});

	test("lead+all: a human's unmentioned top-level post is still the lead's turn", () => {
		expect(evaluateChannelEngagement({ ...lead("all"), authorIsBot: false, addressed: false, topLevel: true })).toEqual(
			{ engaged: true, botAudienceAdmission: false },
		);
	});

	test("open mode is unchanged: an unmentioned bot still engages under all and bot-only", () => {
		expect(evaluateChannelEngagement({ ...open("all"), authorIsBot: true, addressed: false, topLevel: true })).toEqual({
			engaged: true,
			botAudienceAdmission: true,
		});
		expect(
			evaluateChannelEngagement({ ...open("bot-only"), authorIsBot: true, addressed: false, topLevel: true }),
		).toEqual({ engaged: true, botAudienceAdmission: true });
	});
});
