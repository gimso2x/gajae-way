import { expect, test } from "bun:test";
import { redactHistoricalAttachments } from "../src/server/attachment-scope";

test("historical local-path attachment handles lose the path but keep kind, name and size", () => {
	const body =
		"look at this\n[image · photo.png · 9 B · /home/u/.gajaeway/inbound-images/slack-1790428631385-8a215d56-photo.png]";
	expect(redactHistoricalAttachments(body)).toBe(
		"look at this\n[image · photo.png · 9 B · past attachment; not part of this message, do not fetch]",
	);
});

test("a name holding `]` or a path holding spaces still loses its handle", () => {
	const bracketed = "pic\n[image · a]b.png · 1 KB · /home/u/.gajaeway/inbound-images/tg-1-x.png]";
	expect(redactHistoricalAttachments(bracketed)).toBe(
		"pic\n[image · a]b.png · 1 KB · past attachment; not part of this message, do not fetch]",
	);
	const spaced = "pic\n[image · photo.png · 9 B · /home/u/.gajaeway/inbound-images/slack-1-my photo.png]";
	expect(redactHistoricalAttachments(spaced)).toBe(
		"pic\n[image · photo.png · 9 B · past attachment; not part of this message, do not fetch]",
	);
});

test("a path-like fragment inside the name cannot end the redaction early", () => {
	const tricky = "[image · photo · /fake].png · 1 KB · /home/u/.gajaeway/inbound-images/tg-1-real.png]";
	expect(redactHistoricalAttachments(tricky)).toBe(
		"[image · photo · past attachment; not part of this message, do not fetch].png · 1 KB · past attachment; not part of this message, do not fetch]",
	);
});

test("inline attachments separated by punctuation are each redacted", () => {
	const inline =
		"[image · first.png · https://cdn.example/first.png], [image · second.png · https://cdn.example/second.png]";
	expect(redactHistoricalAttachments(inline)).toBe(
		"[image · first.png · past attachment; not part of this message, do not fetch], [image · second.png · past attachment; not part of this message, do not fetch]",
	);
});

test("historical attachment lines lose their url but keep kind, name and size", () => {
	const body =
		"look at this\n[image · IMG_1790.png · 217.3 KB · https://cdn.discordapp.com/attachments/1/2/IMG_1790.png?ex=1&is=2]";
	expect(redactHistoricalAttachments(body)).toBe(
		"look at this\n[image · IMG_1790.png · 217.3 KB · past attachment; not part of this message, do not fetch]",
	);
});

test("every attachment kind and a voice message are redacted, several per body", () => {
	const body = [
		"[voice message · 4.2s · 12 KB · https://cdn.discordapp.com/a.ogg]",
		"[video · clip.mp4 · 3.1 MB · https://cdn.discordapp.com/b.mp4]",
		"[file · https://cdn.discordapp.com/c.bin]",
		"[+2 more attachments]",
	].join("\n");
	expect(redactHistoricalAttachments(body)).toBe(
		[
			"[voice message · 4.2s · 12 KB · past attachment; not part of this message, do not fetch]",
			"[video · clip.mp4 · 3.1 MB · past attachment; not part of this message, do not fetch]",
			"[file · past attachment; not part of this message, do not fetch]",
			"[+2 more attachments]",
		].join("\n"),
	);
});

test("plain urls and prose stay untouched", () => {
	const body = "see https://example.com/page and [not an attachment] and image: foo.png";
	expect(redactHistoricalAttachments(body)).toBe(body);
});

test("sentence punctuation and a `]b.png` continuation never leave a handle", () => {
	const sentence = "posted earlier [image · x.png · https://cdn.example/x.png]. Then the conversation moved on.";
	expect(redactHistoricalAttachments(sentence)).toBe(
		"posted earlier [image · x.png · past attachment; not part of this message, do not fetch]. Then the conversation moved on.",
	);
	const continued = "[image · photo · /fake]b.png · 1 KB · /home/u/.gajaeway/inbound-images/tg-1-real.png]";
	expect(redactHistoricalAttachments(continued)).toBe(
		"[image · photo · past attachment; not part of this message, do not fetch]b.png · 1 KB · past attachment; not part of this message, do not fetch]",
	);
});

test("a name with an embedded newline cannot move the saved path out of redaction", () => {
	const multiline = "[image · a\nb · /home/u/.gajaeway/inbound-images/tg-1-x.png]";
	expect(redactHistoricalAttachments(multiline)).toBe(
		"[image · a\nb · past attachment; not part of this message, do not fetch]",
	);
});
