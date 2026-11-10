/**
 * Local review comments anchored to a source range.
 *
 * The anchor moves with edits. A full reload reattaches by the saved quote
 * and its surrounding text. Nothing here is written into the `.tex` file.
 */

import type { ChangeSet } from "@codemirror/state";

const CONTEXT = 40;

export const TEX_ADD_COMMENT_EVENT = "agentero:tex-add-comment";

export type TexCommentMessage = {
	id: string;
	body: string;
	at: number;
};

export type TexComment = {
	id: string;
	/** Vault-relative path when the file lives in the vault. */
	file: string;
	quote: string;
	prefix: string;
	suffix: string;
	from: number;
	to: number;
	detached: boolean;
	resolved: boolean;
	messages: TexCommentMessage[];
	createdAt: number;
};

export function isCommentableTexPath(path: string | null | undefined): boolean {
	return Boolean(path && /\.tex$/i.test(path));
}

export function commentContext(
	doc: string,
	from: number,
	to: number,
): Pick<TexComment, "quote" | "prefix" | "suffix" | "from" | "to"> {
	const start = Math.max(0, Math.min(from, doc.length));
	const end = Math.max(start, Math.min(to, doc.length));
	return {
		from: start,
		to: end,
		quote: doc.slice(start, end),
		prefix: doc.slice(Math.max(0, start - CONTEXT), start),
		suffix: doc.slice(end, Math.min(doc.length, end + CONTEXT)),
	};
}

/** Move one comment through an edit. A deleted range stays in the list, unmarked. */
export function shiftComment(
	comment: TexComment,
	changes: ChangeSet,
	nextDoc: string,
): TexComment {
	if (comment.detached) return attachComment(nextDoc, comment);
	const from = changes.mapPos(comment.from, -1);
	const to = changes.mapPos(comment.to, 1);
	if (from >= to) return { ...comment, detached: true };
	return { ...comment, ...commentContext(nextDoc, from, to), detached: false };
}

/** Reattach after a reload, when offsets belong to the previous text. */
export function attachComment(doc: string, comment: TexComment): TexComment {
	if (
		!comment.detached &&
		comment.to <= doc.length &&
		doc.slice(comment.from, comment.to) === comment.quote &&
		comment.quote.length > 0
	) {
		return comment;
	}
	const found = findQuote(doc, comment);
	if (!found) return { ...comment, detached: true };
	return {
		...comment,
		...commentContext(doc, found.from, found.to),
		detached: false,
	};
}

export function findQuote(
	doc: string,
	anchor: Pick<TexComment, "quote" | "prefix" | "suffix" | "from">,
): { from: number; to: number } | null {
	const quote = anchor.quote;
	if (!quote) return null;
	const exact = `${anchor.prefix}${quote}${anchor.suffix}`;
	let best: number | null = null;
	if (anchor.prefix || anchor.suffix) {
		let search = 0;
		while (search <= doc.length) {
			const at = doc.indexOf(exact, search);
			if (at < 0) break;
			const from = at + anchor.prefix.length;
			if (
				best === null ||
				Math.abs(from - anchor.from) < Math.abs(best - anchor.from)
			) {
				best = from;
			}
			search = at + 1;
		}
	}
	if (best !== null) return { from: best, to: best + quote.length };
	let search = 0;
	while (search <= doc.length) {
		const at = doc.indexOf(quote, search);
		if (at < 0) break;
		if (
			best === null ||
			Math.abs(at - anchor.from) < Math.abs(best - anchor.from)
		) {
			best = at;
		}
		search = at + 1;
	}
	if (best === null) return null;
	return { from: best, to: best + quote.length };
}

const CHAT_CONTEXT = 240;

/** Full thread for an Agent turn. Bodies stay as written; labels stay English. */
export function commentChatRecord(thread: TexComment): string {
	const lines = [`status: ${thread.resolved ? "resolved" : "open"}`];
	if (thread.detached) {
		lines.push("anchor: the quoted text is no longer in the file");
	}
	for (const [index, message] of thread.messages.entries()) {
		const body = message.body.trim();
		if (!body) continue;
		const when = new Date(message.at)
			.toISOString()
			.slice(0, 16)
			.replace("T", " ");
		lines.push(`${index + 1}. ${when}\n${body}`);
	}
	return lines.join("\n\n");
}

/**
 * Quote plus neighbors for Add to chat. A live match uses the current
 * document; a detached thread keeps the saved quote and its short anchor.
 */
export function commentChatQuote(
	thread: TexComment,
	doc: string | null,
): {
	text: string;
	before: string;
	after: string;
	lineFrom?: number;
	lineTo?: number;
} | null {
	const attached =
		doc != null &&
		!thread.detached &&
		thread.from >= 0 &&
		thread.to <= doc.length &&
		doc.slice(thread.from, thread.to) === thread.quote;
	const text = (
		attached && doc ? doc.slice(thread.from, thread.to) : thread.quote
	).trim();
	if (!text) return null;
	if (!attached || doc == null) {
		return { text, before: thread.prefix, after: thread.suffix };
	}
	return {
		text,
		before: doc.slice(Math.max(0, thread.from - CHAT_CONTEXT), thread.from),
		after: doc.slice(thread.to, Math.min(doc.length, thread.to + CHAT_CONTEXT)),
		lineFrom: lineNumberAt(doc, thread.from),
		lineTo: lineNumberAt(doc, Math.max(thread.from, thread.to - 1)),
	};
}

function lineNumberAt(doc: string, offset: number): number {
	let line = 1;
	const end = Math.min(Math.max(0, offset), doc.length);
	for (let i = 0; i < end; i++) {
		if (doc.charCodeAt(i) === 10) line += 1;
	}
	return line;
}
