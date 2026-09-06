/**
 * Bidirectional scroll synchronization for paired PDF viewers, primarily used
 * by the dual-pane translation layout so the source and translated panes stay
 * aligned as the user scrolls either side.
 */

type ScrollSyncPair = { source: string; target: string };

const pairs = new Map<string, ScrollSyncPair>();
let groupSequence = 1;

export function registerScrollSyncPair(
	sourceDocId: string,
	targetDocId: string,
): string {
	// Remove any stale pairing that involves either docId so reopening the
	// translation pane does not accumulate duplicate listeners.
	for (const [id, pair] of pairs) {
		if (pair.source === sourceDocId || pair.target === targetDocId) {
			pairs.delete(id);
		}
	}
	const groupId = `pdf-scroll-sync-${groupSequence++}`;
	pairs.set(groupId, { source: sourceDocId, target: targetDocId });
	return groupId;
}

export function unregisterScrollSyncPair(groupId: string): void {
	pairs.delete(groupId);
}

export function getScrollSyncPartner(docId: string): string | null {
	for (const pair of pairs.values()) {
		if (pair.source === docId) return pair.target;
		if (pair.target === docId) return pair.source;
	}
	return null;
}

/** Track document IDs that are being scrolled programmatically by a partner. */
const syncingDocIds = new Set<string>();

export function isScrollSyncApplying(docId: string): boolean {
	return syncingDocIds.has(docId);
}

export function runSyncedScroll(docId: string, action: () => void): void {
	syncingDocIds.add(docId);
	action();
	requestAnimationFrame(() => syncingDocIds.delete(docId));
}
