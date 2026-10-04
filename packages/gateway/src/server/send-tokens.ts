import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Egress boundary for `[FILE:]` reply tokens: the same containment policy as
 * gjc's `telegram_send` `resolveContainedFile`, enforced HERE — in the gateway,
 * before any delivery exists and before anything is read or handed to an
 * adapter. A ledger delivery is by contract a postable instruction, so a path
 * that fails this check must never become one: redelivery of a failed row would
 * otherwise hand the file to an adapter again.
 */

/** Slack rejects documents above 50 MiB through the external-upload flow. */
export const SEND_MAX_FILE_BYTES = 50 * 1024 * 1024;
const SEND_MAX_FILE_MIB = SEND_MAX_FILE_BYTES / (1024 * 1024);

export type ContainedFile =
	| { readonly ok: true; readonly path: string; readonly filename: string; readonly sizeBytes: number }
	| { readonly ok: false; readonly error: string };

/**
 * Resolve `requested` against the persona workspace root and confine it via
 * realpath: blocks absolute paths outside the root, `..` traversal, symlinks
 * that escape the root, non-regular files, and files over the size cap. Never
 * reads file content; `stat` is the only filesystem access.
 */
export function resolveContainedFile(root: string, requested: string): ContainedFile {
	let realRoot: string;
	try {
		realRoot = fs.realpathSync(root);
	} catch {
		return { ok: false, error: "workspace root is unavailable" };
	}
	const absolute = path.isAbsolute(requested) ? requested : path.resolve(realRoot, requested);
	let real: string;
	try {
		real = fs.realpathSync(absolute);
	} catch {
		return { ok: false, error: `file not found: ${requested}` };
	}
	const rel = path.relative(realRoot, real);
	if (rel === "" || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
		return { ok: false, error: "path escapes the workspace root; only files inside the workspace can be sent" };
	}
	let stat: fs.Stats;
	try {
		stat = fs.statSync(real);
	} catch {
		return { ok: false, error: `file not found: ${requested}` };
	}
	if (!stat.isFile()) {
		return { ok: false, error: "not a regular file" };
	}
	if (stat.size > SEND_MAX_FILE_BYTES) {
		return { ok: false, error: `file exceeds the Slack upload limit (${SEND_MAX_FILE_MIB} MiB)` };
	}
	return { ok: true, path: real, filename: path.basename(real), sizeBytes: stat.size };
}
