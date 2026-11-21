/**
 * Bidirectional scroll / zoom synchronization for paired PDF viewers.
 *
 * Dual-pane translation mounts two independent `<EmbedPDF>` providers, so
 * plugin scopes cannot see each other. Peers publish zoom into this registry.
 * Positions use content coordinates (see mapScrollByContent) so panes with
 * different viewport sizes still show the same region.
 *
 * The pane under the pointer keeps the browser's compositor scroll. The other
 * pane stays where it is for the whole gesture. When that gesture settles
 * (`scrollend`, or a quiet gap when the event never arrives) the partner
 * jumps straight to the same content point: one `scrollTop` write, no scroll
 * animation, and no per-frame follow. Mirroring both panes on every tick is
 * what stalled dual-pane scrolling.
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
 * A deferred viewport scroll request (fit-width, page jump, zoom anchor) would
 * otherwise land on the next frame and snap the follower back, which is why
 * scrolling the source pane could leave the translation pane still. Callers
 * cancel that request on the follower before writing its scroll position.
 */
const scrollElements = new Map<string, ScrollSyncElementEntry>();

type ScrollSyncElementEntry = {
	element: HTMLElement;
	cancelPendingScroll: () => void;
};

export type ScrollSyncElementHooks = {
	/** Drop a programmatic scrollTo that has not reached the DOM yet. */
	cancelPendingScroll?: () => void;
};

const observedPosition = new Map<string, { x: number; y: number }>();
const commandedPosition = new Map<string, { x: number; y: number }>();
/** Doc whose user gesture currently owns the pair. Follower scrolls are echoes. */
let scrollLeader: string | null = null;
let leaderIdle: ReturnType<typeof setTimeout> | null = null;
/**
 * Panes whose scroll events are zoom-layout side effects. They must not take
 * leadership; a user wheel on that pane clears the hold.
 */
const scrollHold = new Set<string>();

/**
 * How long the leader survives a gap in scroll events when `scrollend` does
 * not fire. Trackpad ticks are far closer than this. When the gap elapses the
 * partner jumps once; it is not moved on the ticks themselves.
 */
const SCROLL_LEADER_IDLE_MS = 180;

/** Writes closer than this are the follower landing on the position we set. */
const SCROLL_ECHO_TOLERANCE_PX = 2;

/** Axes the current gesture has moved. The jump must not invent the other axis. */
let gestureAxes: { x: boolean; y: boolean } | null = null;

/**
 * Previous leader whose coast must not steal the gesture back. Cleared on
 * that pane's own `scrollend`.
 */
let suppressedLeader: string | null = null;

/** True while a settle assigns the follower's scroll offset. */
let committingFollow = false;

function rememberPosition(
	key: string,
	element: HTMLElement,
): { x: number; y: number } {
	const position = { x: element.scrollLeft, y: element.scrollTop };
	observedPosition.set(key, position);
	return position;
}

function clearLeaderIdle(): void {
	if (leaderIdle == null) return;
	clearTimeout(leaderIdle);
	leaderIdle = null;
}

function releaseScrollLeader(key: string): void {
	if (scrollLeader !== key) return;
	clearLeaderIdle();
	// Jump while this pane is still the leader, so the partner's scroll event
	// cannot take over and scroll us back.
	jumpPartner(key, false);
	gestureAxes = null;
	if (scrollLeader === key) scrollLeader = null;
}

function armLeaderIdle(key: string): void {
	clearLeaderIdle();
	leaderIdle = setTimeout(
		() => releaseScrollLeader(key),
		SCROLL_LEADER_IDLE_MS,
	);
}

export function registerScrollSyncElement(
	docId: string,
	element: HTMLElement,
	hooks?: ScrollSyncElementHooks,
): () => void {
	const key = syncKey(docId);
	const entry: ScrollSyncElementEntry = {
		element,
		cancelPendingScroll: hooks?.cancelPendingScroll ?? (() => {}),
	};
	scrollElements.set(key, entry);
	rememberPosition(key, element);
	return () => {
		if (scrollElements.get(key) !== entry) return;
		if (suppressedLeader === key) suppressedLeader = null;
		// Jump the partner before this element goes away, while it can still
		// be measured.
		releaseScrollLeader(key);
		if (scrollElements.get(key) !== entry) return;
		scrollElements.delete(key);
		observedPosition.delete(key);
		commandedPosition.delete(key);
	};
}

export function getScrollSyncElement(docId: string): HTMLElement | null {
	return scrollElements.get(syncKey(docId))?.element ?? null;
}

/** A gesture's final anchor supersedes the zoom plugin's queued scroll. */
export function cancelPendingViewportScroll(docId: string): void {
	scrollElements.get(syncKey(docId))?.cancelPendingScroll();
}

function isNear(
	element: HTMLElement,
	position: { x: number; y: number },
): boolean {
	return (
		Math.abs(element.scrollLeft - position.x) <= SCROLL_ECHO_TOLERANCE_PX &&
		Math.abs(element.scrollTop - position.y) <= SCROLL_ECHO_TOLERANCE_PX
	);
}

function isCommandedEcho(key: string, element: HTMLElement): boolean {
	const commanded = commandedPosition.get(key);
	return commanded != null && isNear(element, commanded);
}

/**
 * Assign the partner's scroll offset directly. Called when a gesture settles,
 * not from the leader's scroll handler: WebKit defers `scrollTop` writes made
 * inside that handler. The command is recorded first so the partner's own
 * scroll event is an echo.
 */
function writeFollowerPosition(
	partnerKey: string,
	entry: ScrollSyncElementEntry,
	next: { x: number; y: number },
): void {
	commandedPosition.set(partnerKey, next);
	entry.cancelPendingScroll();
	const { element } = entry;
	element.scrollLeft = next.x;
	element.scrollTop = next.y;
	const actual = { x: element.scrollLeft, y: element.scrollTop };
	if (!isNear(element, next)) return;
	commandedPosition.set(partnerKey, actual);
	observedPosition.set(partnerKey, actual);
}

function positionMetrics(
	entry: ScrollSyncElementEntry,
	scroll: { x: number; y: number },
): SyncScrollMetrics | null {
	const { element } = entry;
	if (element.scrollHeight <= 0 || element.clientHeight <= 0) return null;
	if (element.scrollWidth <= 0 || element.clientWidth <= 0) return null;
	return {
		scrollWidth: element.scrollWidth,
		scrollHeight: element.scrollHeight,
		clientWidth: element.clientWidth,
		clientHeight: element.clientHeight,
		scrollLeft: scroll.x,
		scrollTop: scroll.y,
	};
}

function followerTarget(
	from: ScrollSyncElementEntry,
	to: ScrollSyncElementEntry,
	actual: { x: number; y: number },
	axes: { x: boolean; y: boolean },
): { x: number; y: number } | null {
	const fromMetrics = positionMetrics(from, actual);
	const toMetrics = positionMetrics(to, {
		x: to.element.scrollLeft,
		y: to.element.scrollTop,
	});
	if (!fromMetrics || !toMetrics) return null;
	const mapped = mapScrollByContent(fromMetrics, toMetrics);
	if (!mapped) return null;
	return mergeSyncedScrollPosition(
		mapped,
		{ x: toMetrics.scrollLeft, y: toMetrics.scrollTop },
		axes,
	);
}

function placeFollower(
	partnerKey: string,
	entry: ScrollSyncElementEntry,
	next: { x: number; y: number },
): void {
	committingFollow = true;
	try {
		writeFollowerPosition(partnerKey, entry, next);
	} finally {
		committingFollow = false;
	}
}

function noteLeaderMotion(key: string, element: HTMLElement): void {
	const actual = { x: element.scrollLeft, y: element.scrollTop };
	const previous = observedPosition.get(key) ?? actual;
	const movedX = Math.abs(actual.x - previous.x) >= 0.5;
	const movedY = Math.abs(actual.y - previous.y) >= 0.5;
	observedPosition.set(key, actual);
	if (!movedX && !movedY) return;
	gestureAxes = {
		x: (gestureAxes?.x ?? false) || movedX,
		y: (gestureAxes?.y ?? false) || movedY,
	};
}

/**
 * Put the partner on the same content point in one write. `force` (zoom
 * settle, first alignment) writes both axes even when this pane has not moved
 * since it registered. A vertical gesture leaves the partner's horizontal
 * offset alone.
 */
function jumpPartner(key: string, force: boolean): void {
	const partnerKey = getScrollSyncPartner(key);
	const from = scrollElements.get(key);
	const to = partnerKey ? scrollElements.get(partnerKey) : undefined;
	if (!partnerKey || !from || !to) return;
	const actual = { x: from.element.scrollLeft, y: from.element.scrollTop };
	observedPosition.set(key, actual);
	const axes = force
		? { x: true, y: true }
		: (gestureAxes ?? { x: false, y: false });
	if (!axes.x && !axes.y) return;
	const next = followerTarget(from, to, actual, axes);
	if (!next) return;
	const gap = Math.max(
		Math.abs(to.element.scrollLeft - next.x),
		Math.abs(to.element.scrollTop - next.y),
	);
	if (gap < 0.5) return;
	placeFollower(partnerKey, to, next);
}

/**
 * Move the partner so its viewport center lands on the same content point.
 * Only axes that actually moved are written, so a vertical gesture does not
 * drag a wider pane sideways. `force` (zoom settle, first alignment) writes
 * both axes even when this pane has not moved since it registered.
 */
export function alignScrollSyncFrom(docId: string, force = false): void {
	const key = syncKey(docId);
	jumpPartner(key, force);
	if (scrollLeader !== key) return;
	clearLeaderIdle();
	gestureAxes = null;
	scrollLeader = null;
}

/** Ignore this pane's scroll events until the returned release runs. */
export function holdScrollSync(docId: string): () => void {
	if (scrollLeader) releaseScrollLeader(scrollLeader);
	const key = syncKey(docId);
	scrollHold.add(key);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		scrollHold.delete(key);
	};
}

/**
 * The user is scrolling this pane (wheel, before the scroll event). Claim it
 * so a programmatic scroll flushed in between cannot become the driver, and
 * so grabbing the other pane abandons the previous gesture instead of jumping
 * onto the pane now under the pointer.
 */
function claimLeader(key: string): void {
	scrollHold.delete(key);
	if (scrollLeader !== key) {
		clearLeaderIdle();
		if (scrollLeader) suppressedLeader = scrollLeader;
		gestureAxes = null;
		scrollLeader = key;
	}
	armLeaderIdle(key);
}

export function handleScrollSyncIntent(docId: string): void {
	const key = syncKey(docId);
	if (!getScrollSyncPartner(key)) return;
	claimLeader(key);
}

/**
 * Scrollbar, keyboard, drag, and the browser's own wheel scroll. Record where
 * the leader went. The partner is not moved here; `scrollend` (or the idle
 * gap) jumps it once.
 */
export function handleScrollSyncScroll(docId: string): void {
	const key = syncKey(docId);
	const entry = scrollElements.get(key);
	if (!entry || scrollHold.has(key)) return;
	if (committingFollow) {
		rememberPosition(key, entry.element);
		return;
	}
	if (suppressedLeader === key) {
		rememberPosition(key, entry.element);
		return;
	}
	if (!getScrollSyncPartner(key)) return;
	if (scrollLeader && scrollLeader !== key) {
		if (isCommandedEcho(key, entry.element)) {
			rememberPosition(key, entry.element);
			return;
		}
		claimLeader(key);
	} else if (scrollLeader !== key) {
		claimLeader(key);
	} else {
		armLeaderIdle(key);
	}
	noteLeaderMotion(key, entry.element);
}

/** Gesture finished. Jump the partner to this pane's content point. */
export function handleScrollSyncScrollEnd(docId: string): void {
	const key = syncKey(docId);
	if (suppressedLeader === key) {
		suppressedLeader = null;
		return;
	}
	if (scrollLeader !== key) return;
	releaseScrollLeader(key);
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
