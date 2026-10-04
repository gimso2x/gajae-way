import { expect, test } from "bun:test";
import { BUILD_INFO, renderVersion } from "../src/build-info";

test("a source run carries no build provenance and says so", () => {
	// No `--define` in `bun test`: both fields fall back to the dev sentinel.
	expect(BUILD_INFO).toEqual({ commit: "dev", builtAt: "dev" });
	expect(renderVersion("0.1.1")).toBe("0.1.1 (dev)");
});

test("a compiled binary renders its commit and build time after the package version", () => {
	expect(renderVersion("0.1.1", { commit: "abc123def", builtAt: "2026-10-04T06:00:00.000Z" })).toBe(
		"0.1.1 (abc123def, 2026-10-04T06:00:00.000Z)",
	);
	// A dirty tree is visible in the suffix, never hidden behind a clean-looking hash.
	expect(renderVersion("0.1.1", { commit: "abc123def-dirty", builtAt: "2026-10-04T06:00:00.000Z" })).toContain(
		"-dirty",
	);
});
