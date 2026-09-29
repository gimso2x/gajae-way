import { expect, test } from "bun:test";
import { CronScheduleError, cronMatches, startCron, validateCronSchedule } from "../src/monitors/triggers/cron";

function reasonOf(schedule: unknown): string {
	try {
		validateCronSchedule(schedule);
	} catch (error) {
		if (error instanceof CronScheduleError) return error.reason;
		throw error;
	}
	return "valid";
}

test("the shared cron contract rejects every schedule the engine cannot fire", () => {
	// The 2026-09-29 crash-loop classes: unparseable token, wrong field count,
	// out-of-range value, zero step.
	expect(reasonOf("bogus")).toBe("field_count");
	expect(() => validateCronSchedule("bogus")).toThrow(CronScheduleError);
	expect(reasonOf("* * * *")).toBe("field_count");
	expect(() => validateCronSchedule("* * * *")).toThrow(/five fields/);
	expect(reasonOf("99 * * * *")).toBe("out_of_range");
	expect(reasonOf("*/0 * * * *")).toBe("invalid_step");
	expect(reasonOf(`*/${"9".repeat(400)} * * * *`)).toBe("invalid_step"); // digits-only overflow step
	// Only the grammar cronFieldMatches evaluates is accepted.
	expect(reasonOf("@hourly")).toBe("field_count");
	expect(reasonOf("0 6 * * JAN")).toBe("unsupported_token");
	expect(reasonOf("0 6 * * 1-2-3")).toBe("unsupported_token");
	expect(reasonOf("5/2 * * * *")).toBe("unsupported_token"); // plain number with step never fires
	expect(reasonOf("0 6 * * 5-2")).toBe("reversed_range");
	// Per-field ranges; day-of-week is 0-6 because the engine reads Date#getDay().
	expect(reasonOf("60 * * * *")).toBe("out_of_range");
	expect(reasonOf("0 24 * * *")).toBe("out_of_range");
	expect(reasonOf("0 6 * 13 *")).toBe("out_of_range");
	expect(reasonOf("0 6 0 * *")).toBe("out_of_range");
	expect(reasonOf("0 6 * * 7")).toBe("out_of_range");
	expect(reasonOf("")).toBe("field_count");
	expect(reasonOf(undefined)).toBe("not_string");
});

test("the shared cron contract accepts every schedule the engine already fires", () => {
	expect(reasonOf("0 6 * * *")).toBe("valid");
	expect(reasonOf("30 */6 * * *")).toBe("valid");
	expect(reasonOf("*/5 10 1-10 1 1")).toBe("valid");
	expect(reasonOf("0,15,30 3-5 * * 0,6")).toBe("valid");
	expect(reasonOf("  30 6   * * *  ")).toBe("valid");
	// The matching engine itself is unchanged.
	expect(cronMatches("0 6 * * *", new Date(2026, 0, 5, 6, 0))).toBe(true);
	expect(cronMatches("30 */6 * * *", new Date(2026, 0, 5, 18, 30))).toBe(true);
	expect(cronMatches("0,15,30 3-5 * * 0,6", new Date(2026, 2, 1, 4, 15))).toBe(true);
});
