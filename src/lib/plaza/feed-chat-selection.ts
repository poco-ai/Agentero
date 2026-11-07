/**
 * Feed item → Agent composer payload (whole item, not a text selection).
 *
 * The RSS detail page can only add a *selected* passage to the chat, which
 * forces the user to open the item and highlight text by hand before the
 * agent ever sees it. The feed list has no entry point at all: its context
 * menu only offers "import into the library".
 *
 * This module builds the same kind of selection chip the editor's
 * "add block to chat" action builds, but for a whole feed item: the title
 * plus the RSS summary (or the resolved full body when the item has one).
 * The chip is ephemeral — it lives in the selection store until the next
 * submitted turn and is never persisted to `marks/`.
 */

import type { FeedItem } from "@/lib/core/bindings";
import { cleanFeedSummary, stripTrailingEllipsis } from "@/lib/plaza/feeds";

/** Keep the chip small enough for the composer to render as a quote. */
const MAX_CHIP_CHARS = 4000;

export type FeedChatSelectionInput = {
	text: string;
	sourcePath: string;
	origin: "markdown";
};

/**
 * Source path for the chip: the original article URL when the feed gave one,
 * otherwise the paper URL, otherwise the title. Mirrors the detail page's
 * selection source so a chip opened from the list and from the detail body
 * point at the same place.
 */
export function feedChatSourcePath(item: FeedItem): string {
	return (
		item.url?.trim() ||
		item.paperUrl?.trim() ||
		item.title.trim() ||
		`feed:${item.id}`
	);
}

/**
 * Body text for the chip. The RSS summary still carries feed boilerplate
 * (arXiv headers, teaser tails) and HTML tags, so it goes through
 * `cleanFeedSummary`; the resolved full body is already Markdown and must
 * keep its paragraph breaks, so it is only stripped of the teaser tail.
 */
export function feedChatBody(item: FeedItem): string {
	const full = item.bodyMarkdown?.trim();
	if (full) return stripTrailingEllipsis(full).trim();
	return stripTrailingEllipsis(cleanFeedSummary(item.summaryText || "")).trim();
}

/**
 * Whole-item text for the chip: `# Title` followed by the body. Returns an
 * empty string when the item carries neither a title nor any text, so
 * callers can skip publishing an empty chip.
 */
export function feedChatText(item: FeedItem): string {
	const title = item.title.trim();
	const body = feedChatBody(item);
	const text = title && body ? `# ${title}\n\n${body}` : title || body;
	return text.slice(0, MAX_CHIP_CHARS);
}

/**
 * Chip payload for one feed item, or null when the item has no usable text.
 */
export function feedChatSelectionInput(
	item: FeedItem,
): FeedChatSelectionInput | null {
	const text = feedChatText(item);
	if (!text) return null;
	return {
		text,
		sourcePath: feedChatSourcePath(item),
		origin: "markdown",
	};
}
