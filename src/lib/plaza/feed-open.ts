/**
 * Open one Plaza feed item from outside the Plaza tab (composer chip click).
 *
 * The Plaza panel keeps its open item in component state, so a chip click has
 * to open the tab first and then hand the id over. Same-window listeners fire
 * immediately; a view that mounts later consumes the pending id on mount.
 * Nothing is deleted and no network is required when the list already holds
 * the item.
 */

import { feedIdFromMentionPath } from "@/lib/plaza/feed-mention";
import { PLAZA_SOURCES } from "@/lib/plaza/sources";
import { openPlazaSource } from "@/lib/workspace/navigation";

type Listener = (feedId: string) => void;

let pendingFeedId: string | null = null;
const listeners = new Set<Listener>();

/** Open the Plaza Feeds tab on the item behind a mention path. */
export function openFeedDetailFromMentionPath(
	path: string | null | undefined,
): void {
	const feedId = feedIdFromMentionPath(path);
	if (!feedId) return;
	const source = PLAZA_SOURCES.find((candidate) => candidate.id === "feeds");
	if (source) openPlazaSource(source);
	pendingFeedId = feedId;
	for (const listener of listeners) listener(feedId);
}

/** Feeds view: take and clear one pending open (or null). */
export function takePendingFeedDetailId(): string | null {
	const next = pendingFeedId;
	pendingFeedId = null;
	return next;
}

export function subscribeFeedDetail(listener: Listener): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}
