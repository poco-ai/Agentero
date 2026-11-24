/**
 * Bidirectional scroll / zoom synchronization for paired PDF viewers.
 *
 * Dual-pane translation mounts two independent `<EmbedPDF>` providers, so
 * plugin scopes cannot see each other. Peers publish zoom into this registry.
 * Positions use content coordinates (see mapScrollByContent) so panes with
 * different viewport sizes still show the same region.
 *
 * The pane under the pointer keeps the browser's compositor scroll. The other
 * pane follows the same content point on every animation frame (see
 * followScrollSyncFrom) so the two columns move together. What it must not do
 * is commit EmbedPDF metrics on every frame: a commit repaints page tiles and
 * re-renders plugin state, and mirroring both panes at display rate is what
 * stalled dual-pane scrolling. The viewport host therefore commits follower
 * metrics at a reduced cadence and lands the exact position
 * (alignScrollSyncFrom) once the gesture settles.
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
	/**
	 * Client-space top of the scroll container. Panes sit side by side, so the
	 * same content should land on the same screen height even when one pane has
	 * extra chrome above it (the paper path bar); without this the mapping can
	 * only align viewport centers.
	 */
	viewportTop?: number;
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
	/**
	 * Cached at gesture start. Reading `scrollHeight` / `clientHeight` on every
	 * followed frame forces a layout flush while page tiles are still settling;
	 * only the scroll offsets change during a scroll gesture.
	 */
	geometry: ScrollSyncGeometry | null;
};

type ScrollSyncGeometry = {
	scrollWidth: number;
	scrollHeight: number;
	clientWidth: number;
	clientHeight: number;
	/** Screen top at gesture start; chrome above a pane shifts it. */
	viewportTop?: number;
};

function elementGeometry(entry: ScrollSyncElementEntry): ScrollSyncGeometry {
	if (entry.geometry) return entry.geometry;
	const { element } = entry;
	const rect =
		typeof element.getBoundingClientRect === "function"
			? element.getBoundingClientRect()
			: null;
	const geometry: ScrollSyncGeometry = {
		scrollWidth: element.scrollWidth,
		scrollHeight: element.scrollHeight,
		clientWidth: element.clientWidth,
		clientHeight: element.clientHeight,
		viewportTop: rect?.top,
	};
	// A hidden or not-yet-laid-out scroller has no box worth caching; keep
	// reading until it settles so the first gesture does not follow nothing.
	if (
		geometry.scrollHeight <= 0 ||
		geometry.clientHeight <= 0 ||
		geometry.scrollWidth <= 0 ||
		geometry.clientWidth <= 0
	) {
		return geometry;
	}
	entry.geometry = geometry;
	return geometry;
}

/**
 * Content metrics changed (pane resize, zoom relayout). Drop the cached
 * geometry for this pane and its partner so the next frame re-reads both.
 */
export function invalidateScrollSyncGeometry(docId: string): void {
	const key = syncKey(docId);
	for (const id of [key, getScrollSyncPartner(key)]) {
		if (!id) continue;
		const entry = scrollElements.get(id);
		if (entry) entry.geometry = null;
	}
}

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
 * Panes whose zoom is mid-transition. While a pair sits at two different zoom
 * levels their content coordinates do not correspond, so neither live follow
 * nor the settle jump may map between them.
 */
const zoomSyncTargets = new Set<string>();

/**
 * How long the leader survives a gap in scroll events when `scrollend` does
 * not fire. Safari only shipped `scrollend` in 26.2, so on the macOS versions
 * this app supports the quiet gap is the real settle signal: keep it short
 * enough that the exact alignment lands right after the finger stops.
 */
const SCROLL_LEADER_IDLE_MS = 90;

/** Writes closer than this are the follower landing on the position we set. */
const SCROLL_ECHO_TOLERANCE_PX = 2;

/** Live follow skips sub-pixel drift; the settle alignment is the exact pass. */
const LIVE_FOLLOW_DEADBAND_PX = 1;

/** Axes the current gesture has moved. The jump must not invent the other axis. */
let gestureAxes: { x: boolean; y: boolean } | null = null;

/**
 * Previous leader whose coast must not steal the gesture back. It stays
 * suppressed until one of its scroll events lands after a quiet gap (WebKit
 * has no `scrollend` before Safari 26.2), or until the user wheels it again.
 */
let suppressedLeader: string | null = null;
let suppressedIdle: ReturnType<typeof setTimeout> | null = null;

function clearSuppressedLeader(): void {
	if (suppressedIdle != null) {
		clearTimeout(suppressedIdle);
		suppressedIdle = null;
	}
	suppressedLeader = null;
}

function armSuppressedIdle(key: string): void {
	if (suppressedIdle != null) clearTimeout(suppressedIdle);
	suppressedIdle = setTimeout(() => {
		suppressedIdle = null;
		if (suppressedLeader === key) suppressedLeader = null;
	}, SCROLL_LEADER_IDLE_MS);
}

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
	const partnerKey = getScrollSyncPartner(key);
	// While the partner's zoom is landing the panes are at different scales;
	// its own reconcile assigns the exact position once the layout settles.
	if (!partnerKey || !zoomSyncTargets.has(partnerKey)) jumpPartner(key, false);
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
		geometry: null,
	};
	scrollElements.set(key, entry);
	rememberPosition(key, element);
	return () => {
		if (scrollElements.get(key) !== entry) return;
		if (suppressedLeader === key) clearSuppressedLeader();
		zoomSyncTargets.delete(key);
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
 * Assign the partner's scroll offset directly. Called from the leader's
 * animation frame or when a gesture settles, never from the leader's scroll
 * handler: WebKit defers `scrollTop` writes made inside that handler. The
 * applied position is recorded so the partner's own scroll event is an echo.
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
	// Record what the element actually applied, not what was requested: a
	// target clamped by the scroller would otherwise leave the command far
	// from the emitted position and the partner's echo would look like input.
	const actual = { x: element.scrollLeft, y: element.scrollTop };
	commandedPosition.set(partnerKey, actual);
	observedPosition.set(partnerKey, actual);
}

function positionMetrics(
	entry: ScrollSyncElementEntry,
	scroll: { x: number; y: number },
): SyncScrollMetrics | null {
	const geometry = elementGeometry(entry);
	if (geometry.scrollHeight <= 0 || geometry.clientHeight <= 0) return null;
	if (geometry.scrollWidth <= 0 || geometry.clientWidth <= 0) return null;
	return { ...geometry, scrollLeft: scroll.x, scrollTop: scroll.y };
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
 * Live-follow the leader's current content point onto the partner. Called from
 * the leader's viewport frame, before that pane's own plugin metrics commit,
 * so both columns move on the same frame. Geometry is cached (see
 * elementGeometry); only the scroll offsets are read here.
 */
export function followScrollSyncFrom(docId: string): void {
	const key = syncKey(docId);
	if (scrollLeader !== key) return;
	const partnerKey = getScrollSyncPartner(key);
	if (!partnerKey || scrollHold.has(key) || scrollHold.has(partnerKey)) return;
	if (zoomSyncTargets.has(key) || zoomSyncTargets.has(partnerKey)) return;
	// The pane that just handed the gesture over is still coasting; writing it
	// every frame would fight that momentum (its events are suppressed).
	if (suppressedLeader === partnerKey) return;
	const from = scrollElements.get(key);
	const to = scrollElements.get(partnerKey);
	if (!from || !to) return;
	const axes = gestureAxes ?? { x: false, y: false };
	if (!axes.x && !axes.y) return;
	const actual = { x: from.element.scrollLeft, y: from.element.scrollTop };
	observedPosition.set(key, actual);
	const next = followerTarget(from, to, actual, axes);
	if (!next) return;
	if (
		Math.abs(to.element.scrollLeft - next.x) < LIVE_FOLLOW_DEADBAND_PX &&
		Math.abs(to.element.scrollTop - next.y) < LIVE_FOLLOW_DEADBAND_PX
	) {
		return;
	}
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
	// A zoom settle or first alignment changes content metrics; live follow
	// reads cached geometry, so drop it before the exact pass.
	if (force) invalidateScrollSyncGeometry(key);
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
	// Zoom relayout changes scrollHeight / clientHeight while held.
	invalidateScrollSyncGeometry(key);
	scrollHold.add(key);
	let released = false;
	return () => {
		if (released) return;
		released = true;
		scrollHold.delete(key);
	};
}

/**
 * Suspend content-coordinate sync while this pane's zoom is landing. The two
 * panes are at different scales in that window, so a mapped follow or jump
 * would land on the wrong page region. The zoom reconcile releases it after
 * the exact alignment.
 */
export function beginZoomSync(docId: string): void {
	zoomSyncTargets.add(syncKey(docId));
}

export function endZoomSync(docId: string): void {
	zoomSyncTargets.delete(syncKey(docId));
}

/**
 * Assign a follower's scroll as part of a zoom hand-off. The write is recorded
 * as our command so the follower's own scroll event cannot take the pair over.
 */
export function setScrollSyncFollowerScroll(
	docId: string,
	scroll: { x: number; y: number },
): void {
	const key = syncKey(docId);
	const entry = scrollElements.get(key);
	if (!entry) return;
	entry.cancelPendingScroll();
	entry.element.scrollLeft = scroll.x;
	entry.element.scrollTop = scroll.y;
	const actual = {
		x: entry.element.scrollLeft,
		y: entry.element.scrollTop,
	};
	commandedPosition.set(key, actual);
	observedPosition.set(key, actual);
}

/**
 * Stop treating this pane's scroll as the pair's driver without moving the
 * partner (a zoom hand-off already placed it).
 */
export function endScrollSyncGesture(docId: string): void {
	const key = syncKey(docId);
	if (scrollLeader !== key) return;
	clearLeaderIdle();
	gestureAxes = null;
	scrollLeader = null;
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
		if (scrollLeader) {
			suppressedLeader = scrollLeader;
			armSuppressedIdle(scrollLeader);
		}
		gestureAxes = null;
		scrollLeader = key;
		// A new gesture starts from whatever the panes measure now.
		invalidateScrollSyncGeometry(key);
	}
	armLeaderIdle(key);
}

export function handleScrollSyncIntent(docId: string): void {
	const key = syncKey(docId);
	if (!getScrollSyncPartner(key)) return;
	// A wheel here is a deliberate grab, even if this pane is still coasting
	// from the gesture it handed over.
	if (suppressedLeader === key) clearSuppressedLeader();
	claimLeader(key);
}

/**
 * Scrollbar, keyboard, drag, and the browser's own wheel scroll. Record where
 * the leader went; the partner follows on the leader's next animation frame
 * and lands the exact position when the gesture settles.
 */
export function handleScrollSyncScroll(docId: string): void {
	const key = syncKey(docId);
	const entry = scrollElements.get(key);
	if (!entry || scrollHold.has(key)) return;
	if (committingFollow) {
		rememberPosition(key, entry.element);
		return;
	}
	if (zoomSyncTargets.has(key)) {
		// This pane's own re-anchor scroll belongs to the zoom transition.
		rememberPosition(key, entry.element);
		return;
	}
	if (suppressedLeader === key) {
		rememberPosition(key, entry.element);
		// Momentum keeps this pane suppressed; after a quiet gap its next
		// motion is the user's and may take the pair back.
		armSuppressedIdle(key);
		return;
	}
	if (!getScrollSyncPartner(key)) return;
	// The settle jump writes the partner after the leader is cleared; its
	// scroll event must not make the partner the new leader.
	if (isCommandedEcho(key, entry.element)) {
		rememberPosition(key, entry.element);
		return;
	}
	if (scrollLeader === key) armLeaderIdle(key);
	else claimLeader(key);
	noteLeaderMotion(key, entry.element);
}

/** Gesture finished. Jump the partner to this pane's content point. */
export function handleScrollSyncScrollEnd(docId: string): void {
	const key = syncKey(docId);
	if (suppressedLeader === key) {
		clearSuppressedLeader();
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
 * True while this pane is following the other one. The viewport host commits
 * its scroll metrics at a reduced cadence in this state: the visual follow is
 * a compositor scroll per frame, but every metrics commit repaints page tiles
 * and re-renders plugin state, and mirroring both panes at display rate is
 * what stalled dual-pane scrolling (#769).
 */
export function isScrollSyncFollower(docId: string): boolean {
	const key = syncKey(docId);
	if (scrollLeader === null || scrollLeader === key) return false;
	// Only the fresh pair being driven is a follower; another open comparison
	// must not inherit the throttle from this gesture.
	return getScrollSyncPartner(key) === scrollLeader;
}

/**
 * Map scroll position from one viewport onto another in content coordinates.
 *
 * Paired panes render the same document at the same zoom. Vertically the same
 * content should land on the same screen height, so the offset is the panes'
 * client-space top difference (one pane may carry the paper path bar above its
 * viewport). When the tops are unknown, fall back to aiming both viewport
 * centers at the same content point. Horizontally the panes are side by side,
 * so their centers are the shared reference instead of a screen column.
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
	const fromTop = from.viewportTop;
	const toTop = to.viewportTop;
	const mappedY =
		fromTop !== undefined && toTop !== undefined
			? from.scrollTop + toTop - fromTop
			: fromCenterY - to.clientHeight / 2;
	return {
		x: Math.min(Math.max(fromCenterX - to.clientWidth / 2, 0), toMaxX),
		y: Math.min(Math.max(mappedY, 0), toMaxY),
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
