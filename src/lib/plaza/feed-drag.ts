/**
 * Drag payload for dropping a feed item into the Agent composer.
 *
 * A dedicated MIME keeps the card out of the two handlers that already read
 * drags: the Vault file-tree move keys on `VAULT_FILE_DRAG_TYPE` (or a
 * `text/plain` path list), and OS file drops key on `Files`. The payload is
 * the plaza mention path, so a drop lands as the same reference chip the
 * context menu produces. The entry is registered on dragstart because the
 * drop target cannot see the row that started the drag.
 */

import {
	isPlazaMentionPath,
	registerPlazaMentionEntry,
} from "@/lib/agent/plaza-mention";
import { dataTransferTypes } from "@/lib/core/file-accept";
import { feedMentionEntry } from "@/lib/plaza/feed-mention";
import type { FeedItem } from "@/lib/plaza/feeds";

export const PLAZA_FEED_DRAG_TYPE = "application/x-agentero-plaza-feed";

export function beginFeedItemDrag(
	dataTransfer: DataTransfer,
	item: FeedItem,
): void {
	const entry = feedMentionEntry(item);
	registerPlazaMentionEntry(entry);
	dataTransfer.effectAllowed = "copy";
	dataTransfer.setData(PLAZA_FEED_DRAG_TYPE, entry.path);
}

export function isFeedItemDrag(
	dataTransfer: DataTransfer | null | undefined,
): boolean {
	return dataTransferTypes(dataTransfer).includes(PLAZA_FEED_DRAG_TYPE);
}

/** Mention path carried by a feed drag, or null for any other drag. */
export function draggedFeedMentionPath(
	dataTransfer: DataTransfer | null | undefined,
): string | null {
	let path = "";
	try {
		path = dataTransfer?.getData(PLAZA_FEED_DRAG_TYPE)?.trim() ?? "";
	} catch {
		// WebKit throws on getData() for types the drag did not set.
		return null;
	}
	return isPlazaMentionPath(path) ? path : null;
}
