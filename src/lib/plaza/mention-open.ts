/**
 * Open one Plaza entry from outside the Plaza tab (composer chip click).
 *
 * Feed items need the tab opened *and* the item selected: the panel keeps its
 * open item in component state, so same-window listeners fire immediately and
 * a view that mounts later consumes the pending id. arXiv Daily entries only
 * have the list view, so opening the source is the whole action. Nothing is
 * deleted and nothing is fetched here.
 */

import { plazaMentionSource } from "@/lib/agent/plaza-mention";
import { feedIdFromMentionPath } from "@/lib/plaza/feed-mention";
import { PLAZA_SOURCES } from "@/lib/plaza/sources";
import { openPlazaSource } from "@/lib/workspace/navigation";

type Listener = (feedId: string) => void;

let pendingFeedId: string | null = null;
const listeners = new Set<Listener>();

/** Open the Plaza source / item behind a plaza mention path. */
export function openPlazaMentionPath(path: string | null | undefined): void {
	const sourceId = plazaMentionSource(path);
	if (!sourceId) return;
	const source = PLAZA_SOURCES.find((candidate) =>
		sourceId === "feed"
			? candidate.id === "feeds"
			: candidate.id === "arxiv-rec",
	);
	if (!source) return;
	openPlazaSource(source);
	if (sourceId !== "feed") return;
	const feedId = feedIdFromMentionPath(path);
	if (!feedId) return;
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
