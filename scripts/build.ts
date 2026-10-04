#!/usr/bin/env bun
/**
 * Compiles the six standalone binaries under dist/ with build provenance
 * baked in (`BUILD_INFO` in @gajae-gateway/protocol). Replaces the previous
 * `bun build --compile ... && ...` chain in package.json so the commit and
 * build time are computed once and passed to every target identically.
 */
import { $ } from "bun";

const TARGETS: ReadonlyArray<readonly [entry: string, outfile: string]> = [
	["packages/gateway/src/main.ts", "dist/gajaeway-gateway"],
	["packages/adapter-discord/src/main.ts", "dist/gajaeway-discord"],
	["packages/adapter-telegram/src/main.ts", "dist/gajaeway-telegram"],
	["packages/adapter-slack/src/main.ts", "dist/gajaeway-slack"],
	["packages/admin/src/main.ts", "dist/gajaeway-admin"],
	["packages/cli/src/main.ts", "dist/gajaeway"],
];

async function buildCommit(): Promise<string> {
	const head = (await $`git rev-parse --short=9 HEAD`.quiet().nothrow().text()).trim();
	if (!head) return "unknown";
	const dirty = (await $`git status --porcelain --untracked-files=no`.quiet().nothrow().text()).trim().length > 0;
	return dirty ? `${head}-dirty` : head;
}

const commit = await buildCommit();
const builtAt = new Date().toISOString();
console.log(`build commit=${commit} builtAt=${builtAt}`);

for (const [entry, outfile] of TARGETS) {
	const result = await Bun.build({
		entrypoints: [entry],
		compile: { outfile },
		define: {
			GAJAEWAY_BUILD_COMMIT: JSON.stringify(commit),
			GAJAEWAY_BUILD_TIME: JSON.stringify(builtAt),
		},
	});
	if (!result.success) {
		for (const log of result.logs) console.error(log);
		process.exit(1);
	}
	console.log(`built ${outfile}`);
}
