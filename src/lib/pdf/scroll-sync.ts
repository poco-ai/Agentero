/**
 * Bidirectional scroll / zoom synchronization for paired PDF viewers.
 *
 * Dual-pane translation mounts two independent `<EmbedPDF>` providers, so
 * plugin scopes cannot see each other. Peers publish themselves into this
 * module-level registry; the pair's source viewer wires the listeners.
 * Positions are exchanged in content coordinates (see mapScrollByContent) so
 * panes with different viewport sizes still show the same region.
 */

import { stripEmbedPdfRevision } from "@/lib/pdf/document-id";

type ScrollSyncPair = { source: string; target: string };

export type SyncScrollMetrics = {
	scrollTop: number;
	scrollLeft: number;
	scrollHeight: number;
	scrollWidth: number;
	clientHeight: number;
	clientWidth: number;
};

export type ScrollSyncPeer = {
	getMetrics: () => SyncScrollMetrics;
	scrollTo: (position: { x: number; y: number }) => void;
	onScrollChange: (listener: () => void) => () => void;
	getZoom: () => number;
	setZoom: (zoom: number) => void;
	onZoomChange: (listener: (zoom: number) => void) => () => void;
};

const pairs = new Map<string, ScrollSyncPair>();
let groupSequence = 1;
const peers = new Map<string, ScrollSyncPeer>();
const peerListeners = new Set<() => void>();
const pairListeners = new Set<() => void>();

function notify(listeners: Set<() => void>): void {
	for (const listener of listeners) listener();
}

/**
 * Registry keys use the revision-stripped base id: the pair is registered
 * with tab ids while each viewer mounts its own `tab::r<n>` (bytes-backed
 * documents get a fresh revision per ArrayBuffer read), and the same base id
 * has at most one live viewer instance, so stripping cannot collide.
 */
function syncKey(docId: string): string {
	return stripEmbedPdfRevision(docId);
}

export function registerScrollSyncPeer(
	docId: string,
	peer: ScrollSyncPeer,
): () => void {
	const key = syncKey(docId);
	peers.set(key, peer);
	notify(peerListeners);
	return () => {
		if (peers.get(key) !== peer) return;
		peers.delete(key);
		notify(peerListeners);
	};
}

export function getScrollSyncPeer(docId: string): ScrollSyncPeer | null {
	return peers.get(syncKey(docId)) ?? null;
}

/**
 * Live scrolling elements by docId, registered by each pane's viewport host.
 *
 * Sync writes go directly to the element instead of through the viewport
 * plugin's scroll-request pipeline, which defers every programmatic scroll by
 * an extra animation frame (see DockviewViewport's onScrollRequest) — on top
 * of our own frame coalescing that put the follower 2-3 frames behind.
 */
const scrollElements = new Map<string, HTMLElement>();

export function registerScrollSyncElement(
	docId: string,
	element: HTMLElement,
): () => void {
	const key = syncKey(docId);
	scrollElements.set(key, element);
	return () => {
		if (scrollElements.get(key) === element) scrollElements.delete(key);
	};
}

export function getScrollSyncElement(docId: string): HTMLElement | null {
	return scrollElements.get(syncKey(docId)) ?? null;
}

export function subscribeScrollSyncPeers(listener: () => void): () => void {
	peerListeners.add(listener);
	return () => peerListeners.delete(listener);
}

export function subscribeScrollSyncPairs(listener: () => void): () => void {
	pairListeners.add(listener);
	return () => pairListeners.delete(listener);
}

export function registerScrollSyncPair(
	sourceDocId: string,
	targetDocId: string,
): string {
	const source = syncKey(sourceDocId);
	const target = syncKey(targetDocId);
	// Remove any stale pairing that involves either docId so reopening the
	// translation pane does not accumulate duplicate listeners. Comparing on
	// the stripped ids also retires pairs left behind by earlier buffer
	// revisions of the same documents.
	for (const [id, pair] of pairs) {
		if (
			pair.source === source ||
			pair.target === target ||
			pair.source === target ||
			pair.target === source
		) {
			pairs.delete(id);
		}
	}
	const groupId = `pdf-scroll-sync-${groupSequence++}`;
	pairs.set(groupId, { source, target });
	notify(pairListeners);
	return groupId;
}

export function unregisterScrollSyncPair(groupId: string): void {
	if (!pairs.delete(groupId)) return;
	notify(pairListeners);
}

export function getScrollSyncPartner(docId: string): string | null {
	const key = syncKey(docId);
	for (const pair of pairs.values()) {
		if (pair.source === key) return pair.target;
		if (pair.target === key) return pair.source;
	}
	return null;
}

export function getScrollSyncRole(docId: string): "source" | "target" | null {
	const key = syncKey(docId);
	for (const pair of pairs.values()) {
		if (pair.source === key) return "source";
		if (pair.target === key) return "target";
	}
	return null;
}

/**
 * Map scroll position from one viewport onto another in content coordinates.
 *
 * Paired panes render the same document at the same zoom, so their content
 * coordinate systems are identical. Instead of mirroring the scroll *ratio*
 * (which lands on a different region whenever the panes have different client
 * sizes — comment rail, split ratio, scrollbar), keep both viewport centers
 * aimed at the same content point.
 */
export function mapScrollByContent(
	from: SyncScrollMetrics,
	to: SyncScrollMetrics,
): { x: number; y: number } | null {
	if (from.scrollHeight <= 0 || from.scrollWidth <= 0) return null;
	if (from.clientHeight <= 0 || from.clientWidth <= 0) return null;
	if (to.scrollHeight <= 0 || to.scrollWidth <= 0) return null;
	if (to.clientHeight <= 0 || to.clientWidth <= 0) return null;
	const fromCenterY = from.scrollTop + from.clientHeight / 2;
	const fromCenterX = from.scrollLeft + from.clientWidth / 2;
	const toMaxY = Math.max(0, to.scrollHeight - to.clientHeight);
	const toMaxX = Math.max(0, to.scrollWidth - to.clientWidth);
	return {
		x: Math.min(Math.max(fromCenterX - to.clientWidth / 2, 0), toMaxX),
		y: Math.min(Math.max(fromCenterY - to.clientHeight / 2, 0), toMaxY),
	};
}

/**
 * Apply only the axes the user actually moved. In particular, a vertical
 * wheel event in the translation pane must not recompute the source pane's
 * horizontal offset just because the two panes have different widths.
 */
export function mergeSyncedScrollPosition(
	mapped: { x: number; y: number },
	current: { x: number; y: number },
	changed: { x: boolean; y: boolean },
): { x: number; y: number } {
	return {
		x: changed.x ? mapped.x : current.x,
		y: changed.y ? mapped.y : current.y,
	};
}
