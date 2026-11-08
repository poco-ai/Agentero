/**
 * Feed item → plaza mention entry.
 *
 * A feed item is not a Vault file, so the Agent reaches it through the plaza
 * mention channel (the same one `@` writes): a virtual
 * `agentero:plaza/feeds/<id>` path whose send-time expansion prints the title,
 * source, URL, date and a capped excerpt. The article itself stays behind the
 * URL, so a long item never has to be pasted into the prompt, and the turn
 * pipeline never grants the virtual path as a readable file.
 */

import {
	feedMentionPath,
	PLAZA_MENTION_PREFIX,
	type PlazaMentionEntry,
} from "@/lib/agent/plaza-mention";
import {
	type FeedItem,
	stripFeedMeta,
	stripTrailingEllipsis,
} from "@/lib/plaza/feeds";

/**
 * Longest excerpt copied into the prompt. Long enough to judge relevance,
 * short enough that several items still fit one turn; the URL line carries
 * whatever this cuts.
 */
export const MAX_FEED_EXCERPT_CHARS = 600;

export type FeedMentionExcerpt = {
	text: string;
	truncated: boolean;
};

const LINE_BREAK_TAG = /<br\s*\/?>/gi;
const LIST_ITEM_TAG = /<li\b[^>]*>/gi;
const BLOCK_END_TAG =
	/<\/(?:p|div|section|article|h[1-6]|blockquote|pre|ul|ol|table|tr|figure)\s*>/gi;
const HTML_TAG = /<\/?[a-z][^>]*>/i;

/**
 * RSS summaries are HTML. Block ends become paragraph breaks and list items
 * become `- ` so the excerpt survives Markdown rendering as readable text
 * instead of one collapsed line.
 */
function htmlExcerptToMarkdown(raw: string): string {
	return raw
		.replace(LINE_BREAK_TAG, "\n")
		.replace(LIST_ITEM_TAG, "\n- ")
		.replace(BLOCK_END_TAG, "\n\n")
		.replace(/<[^>]+>/g, " ")
		.replace(/&nbsp;/gi, " ")
		.replace(/&amp;/gi, "&")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">")
		.replace(/&quot;/gi, '"')
		.replace(/&#0*39;|&apos;/gi, "'");
}

function normalizeExcerptLines(text: string): string {
	return stripTrailingEllipsis(
		text
			.replace(/\r\n?/g, "\n")
			.replace(/[ \t]+/g, " ")
			.replace(/ *\n */g, "\n")
			.replace(/\n{3,}/g, "\n\n"),
	).trim();
}

/**
 * Clean one RSS summary / resolved body into prompt-sized text. A resolved
 * body is already Markdown and keeps its structure; an RSS summary goes
 * through the HTML pass first. Line breaks stay so the excerpt can render as
 * Markdown in the hover preview; only the length is capped.
 */
export function feedMentionExcerpt(
	raw: string,
	options?: { html?: boolean },
): FeedMentionExcerpt {
	const html = options?.html ?? HTML_TAG.test(raw);
	const text = normalizeExcerptLines(
		stripFeedMeta(html ? htmlExcerptToMarkdown(raw) : raw),
	);
	const chars = Array.from(text);
	if (chars.length <= MAX_FEED_EXCERPT_CHARS) {
		return { text, truncated: false };
	}
	const head = chars.slice(0, MAX_FEED_EXCERPT_CHARS).join("").trimEnd();
	return { text: `${head}…`, truncated: true };
}

/** Whether a mention path points at one Plaza feed item. */
export function isFeedMentionPath(path: string | null | undefined): boolean {
	return Boolean(path?.startsWith(`${PLAZA_MENTION_PREFIX}feeds/`));
}

/** Feed item id behind a plaza mention path (null for any other path). */
export function feedIdFromMentionPath(
	path: string | null | undefined,
): string | null {
	if (!isFeedMentionPath(path)) return null;
	const id = path?.slice(`${PLAZA_MENTION_PREFIX}feeds/`.length).trim();
	return id || null;
}

export function feedMentionEntry(item: FeedItem): PlazaMentionEntry {
	const body = item.bodyMarkdown?.trim();
	const excerpt = feedMentionExcerpt(body || item.summaryText, { html: !body });
	return {
		path: feedMentionPath(item.id),
		source: "feed",
		title: item.title.trim(),
		url: item.paperUrl?.trim() || item.url?.trim() || null,
		abstract: excerpt.text || null,
		abstractTruncated: excerpt.truncated,
		publishedAt: item.publishedAt,
		sourceLabel: item.subscriptionTitle?.trim() || "Feeds",
	};
}
