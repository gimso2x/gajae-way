/**
 * Build provenance compiled into every standalone binary.
 *
 * `scripts/build.ts` passes `--define GAJAEWAY_BUILD_COMMIT=... GAJAEWAY_BUILD_TIME=...`
 * to `bun build --compile`, so a deployed `dist/gajaeway-*` can always say
 * which commit produced it; a source run (`bun packages/.../main.ts`) reports
 * `dev`. Without this, a host running six binaries copied from some worktree
 * has no way to tell which checkout they came from (2026-10-04: dist/ built on
 * 10-03 from a worktree 59 commits behind origin/main, indistinguishable from
 * a current build).
 */
declare const GAJAEWAY_BUILD_COMMIT: string | undefined;
declare const GAJAEWAY_BUILD_TIME: string | undefined;

export interface BuildInfo {
	/** Short git commit, suffixed `-dirty` when the tree had uncommitted changes; `dev` outside a build. */
	readonly commit: string;
	/** ISO-8601 build time; `dev` outside a build. */
	readonly builtAt: string;
}

function defined(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const BUILD_INFO: BuildInfo = {
	commit: defined(typeof GAJAEWAY_BUILD_COMMIT === "undefined" ? undefined : GAJAEWAY_BUILD_COMMIT) ?? "dev",
	builtAt: defined(typeof GAJAEWAY_BUILD_TIME === "undefined" ? undefined : GAJAEWAY_BUILD_TIME) ?? "dev",
};

/** `0.1.1 (abc1234, 2026-10-04T06:00:00Z)` or `0.1.1 (dev)` for a source run. */
export function renderVersion(packageVersion: string, info: BuildInfo = BUILD_INFO): string {
	return info.commit === "dev" ? `${packageVersion} (dev)` : `${packageVersion} (${info.commit}, ${info.builtAt})`;
}
