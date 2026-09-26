/**
 * Live finding (jip-gajae, 2026-09-02): a message with no attachment was
 * answered by reading an unrelated, months-old image from the workspace and
 * describing it as if the user had just sent it. Attachments are only what
 * the current message's body lists; the model must not go looking on disk.
 */
export const ATTACHMENT_SCOPE_NOTICE =
	'Attachments: a message includes an attachment only when its body lists one (e.g. "image: name.png", "voice message", a URL). If the current message lists none, it has none — do not open, search for, or describe files on disk as if the user had attached them, and never treat an older file as part of the current message.';

/**
 * Adapters render an attachment as `[kind · name · size · url]` so the live turn
 * can fetch it. Replayed history must not: a fresh session's 24h recap carried
 * those CDN urls verbatim, and the model opened days-old screenshots and talked
 * about them as the current message (live: jip-gajae, 2026-09-01, the
 * "look-at-live-screenshot" incident). History keeps the human-readable part
 * and loses the handle. Slack/Telegram ingest (2026-09-26) replaced url handles
 * with saved local paths, so an absolute-path handle redacts exactly like a url:
 * a days-old file still on disk is the same "not part of this message" hazard.
 *
 * even ` · `, and a name may contain a newline — so no character-level rule can
 * tell where a bracket ends, and a wrong guess leaves a handle behind. The
 * redactor therefore draws the line at the attachment start: every handle-shaped
 * token (a URL, or an absolute path) anywhere after that point in the body is
 * replaced. False positives (a name that embeds a path, prose after the
 * bracket) cost history cosmetics; survivors cost incidents.
 */
const ATTACHMENT_START = /\[(?:image|video|audio|file|voice message) · /;
const HANDLE = /(^|[\s[])(https?:\/\/[^\s\]]+|\/[^\]]*)/g;
const REDACTED = "past attachment; not part of this message, do not fetch";

export function redactHistoricalAttachments(body: string): string {
	const start = body.search(ATTACHMENT_START);
	if (start === -1) return body;
	// The separator before a handle is kept so spacing stays human-readable.
	return (
		body.slice(0, start) + body.slice(start).replace(HANDLE, (_match, separator: string) => `${separator}${REDACTED}`)
	);
}
