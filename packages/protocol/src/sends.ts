import type { ReactionReply } from "./reactions";
import { isPlatformMessageId, REACT_TOKEN, resolveReactionEmoji } from "./reactions";

/**
 * Outbound file/channel send tokens — the second and third reply-token modes,
 * next to reactions. They follow the same leading-token, all-or-nothing shape
 * as `[REACT:…]`, with one stricter rule: once a send token has been claimed, a
 * malformed token anywhere in the run REFUSES the reply instead of delivering
 * it verbatim, because a routing intent ("post there", "upload this") must
 * never silently degrade into a plain message in the current thread.
 *
 *   [FILE:report.pdf]                upload a workspace file to the current thread
 *   [FILE:a.md][FILE:b.md] caption   two files; the text is the first file's caption
 *   [SEND:C0123456789]               post the rest of the reply to another channel
 *   [SEND:C0123456789/1726543210.123456]  …inside one specific thread
 *
 * Parsing is platform-neutral; whether the ORIGIN supports the tokens at all is
 * the gateway's decision (currently Slack only).
 */

/** Maximum `[FILE:]` tokens one reply may claim. */
export const FILES_PER_TURN_CAP = 10;

/**
 * A workspace file the persona asked to upload. `path` is the realpath-resolved
 * location INSIDE the persona workspace root, validated by the gateway before
 * the delivery exists; an adapter reads exactly this path. `caption` rides only
 * on the first file of a reply and becomes its `initial_comment`.
 */
export interface FileSendRef {
	readonly path: string;
	readonly filename: string;
	readonly sizeBytes: number;
	readonly caption?: string;
}

/**
 * A Slack target that overrides where the reply text is posted: a channel, or
 * one thread inside it. The bot must already be a member of the channel; that
 * gate lives with the platform adapter, which is the only side that can ask.
 */
export interface SendTargetRef {
	readonly channelId: string;
	readonly threadTs?: string;
}

export interface OutboundReply {
	readonly reactions: ReactionReply["reactions"];
	/** Requested file paths, in token order; resolved against the workspace root. */
	readonly files: readonly string[];
	readonly sendTarget?: SendTargetRef;
	/** Reply text after the tokens; empty means token-only (no text message). */
	readonly body: string;
	/**
	 * Set when the token run itself is invalid. The reply must be refused as a
	 * whole — never delivered verbatim, never partially honoured.
	 */
	readonly refusal?: string;
}

const FILE_TOKEN = /^\s*\[FILE:([^\]\n]*)\]/;
const SEND_TOKEN = /^\s*\[SEND:([^\]\n]*)\]/;
// Slack ids are short alphanumeric tokens (C/D/G channels, ts `sec.frac`).
const SEND_CHANNEL_ID = /^[A-Za-z0-9]{1,64}$/;
const SEND_THREAD_TS = /^\d{1,16}\.\d{1,9}$/;

/**
 * Parses the leading token run of a reply. Returns undefined when the reply
 * starts with no token at all — or with a malformed `[REACT:]` and nothing
 * else, which stays plain text exactly like `parseReactionReply`. A malformed
 * `[FILE:]`/`[SEND:]` (or either token appearing once the run is already
 * poisoned) returns a `refusal` instead of verbatim text: a declared routing
 * intent may not degrade into an ordinary message.
 */
export function parseOutboundReply(text: string): OutboundReply | undefined {
	let rest = text;
	const reactions: ReactionReply["reactions"][number][] = [];
	const files: string[] = [];
	let sendTarget: SendTargetRef | undefined;
	let refusal: string | undefined;
	for (;;) {
		const react = rest.match(REACT_TOKEN);
		const file = rest.match(FILE_TOKEN);
		const send = rest.match(SEND_TOKEN);
		const match = react ?? file ?? send;
		if (!match) break;
		const [token, argument = ""] = match;
		if (react) {
			const at = argument.lastIndexOf("@");
			const emojiPart = at === -1 ? argument : argument.slice(0, at);
			const targetMessageId = at === -1 ? undefined : argument.slice(at + 1).trim();
			const resolved = resolveReactionEmoji(emojiPart);
			const malformed = !resolved || (at !== -1 && !isPlatformMessageId(targetMessageId ?? ""));
			if (malformed) {
				// A bad reaction before any send token is the documented all-or-nothing
				// fallback (plain text). After a send token — or when one follows — the
				// reply has declared routing intent and is refused instead.
				const after = rest.slice(token.length);
				if (files.length > 0 || sendTarget || FILE_TOKEN.test(after) || SEND_TOKEN.test(after)) {
					refusal = "malformed [REACT] token inside a [FILE]/[SEND] reply";
					break;
				}
				return undefined;
			}
			reactions.push({
				emoji: resolved.unicode,
				emojiName: resolved.name,
				...(targetMessageId ? { targetMessageId } : {}),
			});
			rest = rest.slice(token.length);
			continue;
		}
		if (file) {
			const requested = argument.trim();
			if (!requested) {
				refusal = "[FILE] token has no path";
				break;
			}
			if (files.length >= FILES_PER_TURN_CAP) {
				refusal = `more than ${FILES_PER_TURN_CAP} [FILE] tokens in one reply`;
				break;
			}
			files.push(requested);
			rest = rest.slice(token.length);
			continue;
		}
		const slash = argument.indexOf("/");
		const channelId = (slash === -1 ? argument : argument.slice(0, slash)).trim();
		const threadTs = slash === -1 ? undefined : argument.slice(slash + 1).trim();
		if (
			!SEND_CHANNEL_ID.test(channelId) ||
			threadTs === "" ||
			(threadTs !== undefined && !SEND_THREAD_TS.test(threadTs))
		) {
			refusal = "[SEND] target must be <channelId> or <channelId>/<threadTs>";
			break;
		}
		if (sendTarget) {
			refusal = "more than one [SEND] token in one reply";
			break;
		}
		sendTarget = { channelId, ...(threadTs ? { threadTs } : {}) };
		rest = rest.slice(token.length);
	}
	if (reactions.length === 0 && files.length === 0 && !sendTarget && !refusal) return undefined;
	return {
		reactions,
		files,
		...(sendTarget ? { sendTarget } : {}),
		body: rest.trim(),
		...(refusal ? { refusal } : {}),
	};
}
