/**
 * "Add to chat" for a whole feed item.
 *
 * Registers the item's plaza mention and hands its virtual path to the Agent
 * composer — the same attach channel the file tree uses. Nothing is copied
 * into the prompt here: the send pipeline expands the metadata, and the Agent
 * opens the original URL when the excerpt is not enough.
 */

import { presentAgentComposer } from "@/lib/agent/composer-focus";
import { broadcastAgentAttachContext } from "@/lib/agent/context-attach";
import { registerPlazaMentionEntry } from "@/lib/agent/plaza-mention";
import { feedMentionEntry } from "@/lib/plaza/feed-mention";
import type { FeedItem } from "@/lib/plaza/feeds";

export function addFeedItemToChat(item: FeedItem): void {
	const entry = feedMentionEntry(item);
	registerPlazaMentionEntry(entry);
	broadcastAgentAttachContext([entry.path]);
	presentAgentComposer();
}
