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
	cleanFeedSummary,
	type FeedItem,
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

/**
 * Clean one RSS summary / resolved body into prompt-sized text. Both surfaces
 * carry markup and feed boilerplate, so the cleaning always applies; only the
 * cap depends on the caller.
 */
export function feedMentionExcerpt(raw: string): FeedMentionExcerpt {
	const cleaned = stripTrailingEllipsis(cleanFeedSummary(raw)).trim();
	const chars = Array.from(cleaned);
	if (chars.length <= MAX_FEED_EXCERPT_CHARS) {
		return { text: cleaned, truncated: false };
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
	const excerpt = feedMentionExcerpt(
		item.bodyMarkdown?.trim() || item.summaryText,
	);
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
