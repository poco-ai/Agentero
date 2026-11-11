/**
 * Buffered activity tracker. Call `track()` from action funnels; events flush
 * to Host `activity_record_events` → XDG `usage.sqlite`.
 */

import { type ActivityRecord, recordActivityEvents } from "@/lib/activity/api";
import { type ActivityKind, isActivityKind } from "@/lib/activity/kinds";
import type { Json } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { toVaultRelative } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import { getVaultPath } from "@/lib/vault/store";

const FLUSH_MS = 5000;
const FLUSH_SIZE = 50;
const DEDUPE_MS = 1000;
const MAX_FOCUS_MS = 30 * 60 * 1000;
const SESSION_MIN_MS = 10_000;

type TrackPayload = {
	vault?: string | null;
	path?: string;
	mode?: string;
	durMs?: number;
	extra?: Json;
};

type Buffered = ActivityRecord & { _key: string; _at: number };

const buffer: Buffered[] = [];
const recent = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
type FocusedPaper = { path: string; vault: string | null };
let selectedPaper: FocusedPaper | null = null;
let focused: (FocusedPaper & { startedAt: number; elapsedMs: number }) | null =
	null;
let foreground = true;
let checkpointTimer: ReturnType<typeof setInterval> | null = null;
let flushPromise: Promise<void> | null = null;
const readingDurationListeners = new Set<() => void>();

export function track(
	kind: ActivityKind | string,
	payload: TrackPayload = {},
): void {
	if (!isActivityKind(kind)) {
		logger.warn("activity: unknown kind", { kind });
		return;
	}
	if (!isTauri()) return;

	const vault =
		(payload.vault === undefined ? getVaultPath() : payload.vault) ?? undefined;
	const path = normalizePath(vault, payload.path);
	const key = `${kind}|${path ?? ""}|${payload.mode ?? ""}`;
	const now = Date.now();
	const last = recent.get(key);
	// Duration slices are additive, including rapid switches between split panes.
	if (payload.durMs == null) {
		if (last != null && now - last < DEDUPE_MS) return;
		recent.set(key, now);
	}

	buffer.push({
		ts: new Date(now).toISOString(),
		vault,
		kind,
		path,
		mode: payload.mode,
		durMs: payload.durMs,
		extra: payload.extra,
		_key: key,
		_at: now,
	});
	if (buffer.length >= FLUSH_SIZE) {
		void flushActivity();
		return;
	}
	scheduleFlush();
}

/** The workspace supplies exactly one active paper, regardless of visible splits. */
export function notePaperFocus(absOrRelPath: string | null): void {
	const vault = getVaultPath();
	const path = absOrRelPath ? normalizePath(vault, absOrRelPath) : null;
	if (selectedPaper?.path === path && selectedPaper?.vault === vault) return;
	finishPaperFocus();
	selectedPaper = path ? { path, vault } : null;
	resumePaperFocus();
}

function checkpointPaperFocus(): void {
	if (!focused) return;
	// Keep the segment origin fixed: checkpoints consume one shared allowance.
	const elapsedMs = Math.max(
		focused.elapsedMs,
		Math.min(Date.now() - focused.startedAt, MAX_FOCUS_MS),
	);
	const durMs = elapsedMs - focused.elapsedMs;
	focused.elapsedMs = elapsedMs;
	if (durMs > 0) {
		track("paper.blur", { path: focused.path, vault: focused.vault, durMs });
	}
}

function finishPaperFocus(): void {
	if (!focused) return;
	checkpointPaperFocus();
	if (focused.elapsedMs >= SESSION_MIN_MS) {
		track("paper.session", {
			path: focused.path,
			vault: focused.vault,
			durMs: focused.elapsedMs,
		});
	}
	focused = null;
}

function resumePaperFocus(): void {
	if (focused || !selectedPaper || !foreground) return;
	if (typeof document !== "undefined" && document.visibilityState === "hidden")
		return;
	focused = { ...selectedPaper, startedAt: Date.now(), elapsedMs: 0 };
	track("paper.focus", { path: focused.path, vault: focused.vault });
}

export function startActivityTracking(): () => void {
	if (started || typeof window === "undefined") return () => undefined;
	started = true;
	foreground = typeof document === "undefined" || document.hasFocus();
	if (!foreground) finishPaperFocus();
	else resumePaperFocus();
	const onHide = () => {
		foreground = false;
		finishPaperFocus();
		void flushActivity();
	};
	const onShow = () => {
		foreground = typeof document === "undefined" || document.hasFocus();
		resumePaperFocus();
	};
	const onVisibility = () => {
		if (document.visibilityState === "hidden") onHide();
		else onShow();
	};
	window.addEventListener("blur", onHide);
	window.addEventListener("focus", onShow);
	window.addEventListener("pagehide", onHide);
	window.addEventListener("beforeunload", onHide);
	document.addEventListener("visibilitychange", onVisibility);
	checkpointTimer = setInterval(() => {
		checkpointPaperFocus();
		void flushActivity();
	}, FLUSH_MS);
	return () => {
		onHide();
		window.removeEventListener("blur", onHide);
		window.removeEventListener("focus", onShow);
		window.removeEventListener("pagehide", onHide);
		window.removeEventListener("beforeunload", onHide);
		document.removeEventListener("visibilitychange", onVisibility);
		clearInterval(checkpointTimer ?? undefined);
		checkpointTimer = null;
		started = false;
	};
}

/** Read views refresh only after persisted duration slices change. */
export function subscribeReadingDurationChanges(
	listener: () => void,
): () => void {
	readingDurationListeners.add(listener);
	return () => {
		readingDurationListeners.delete(listener);
	};
}

export async function flushActivity(): Promise<void> {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	if (flushPromise) {
		await flushPromise;
		if (buffer.length) await flushActivity();
		return;
	}
	if (buffer.length === 0) return;
	const batch = buffer
		.splice(0, buffer.length)
		.map(({ _key, _at, ...event }) => {
			void _key;
			void _at;
			return event;
		});
	flushPromise = (async () => {
		try {
			await recordActivityEvents(batch);
			if (batch.some((event) => event.kind === "paper.blur")) {
				for (const listener of readingDurationListeners) listener();
			}
		} catch (error) {
			logger.warn("activity flush failed", { error: errorText(error) });
		}
	})();
	try {
		await flushPromise;
	} finally {
		flushPromise = null;
	}
}

function scheduleFlush(): void {
	if (flushTimer) return;
	flushTimer = setTimeout(() => {
		flushTimer = null;
		void flushActivity();
	}, FLUSH_MS);
}

function normalizePath(
	vault: string | null | undefined,
	path: string | undefined,
): string | undefined {
	if (!path) return undefined;
	const rel = toVaultRelative(vault ?? null, path)
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	return rel || undefined;
}

/** Test helper: reset in-memory buffer. */
export function resetActivityBufferForTests(): void {
	buffer.length = 0;
	recent.clear();
	selectedPaper = null;
	focused = null;
	foreground = true;
	clearInterval(checkpointTimer ?? undefined);
	checkpointTimer = null;
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	flushPromise = null;
	started = false;
}

export function pendingActivityCountForTests(): number {
	return buffer.length;
}
