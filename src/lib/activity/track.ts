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
	path?: string;
	mode?: string;
	durMs?: number;
	extra?: Json;
};

type Buffered = ActivityRecord & { _key: string; _at: number };

const buffer: Buffered[] = [];
const recent = new Map<string, number>();
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let segmentTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;
let focused: { path: string; startedAt: number } | null = null;
let flushing = false;

export function track(
	kind: ActivityKind | string,
	payload: TrackPayload = {},
): void {
	if (!isActivityKind(kind)) {
		logger.warn("activity: unknown kind", { kind });
		return;
	}
	if (!isTauri()) return;

	const vault = getVaultPath() ?? undefined;
	const path = normalizePath(vault, payload.path);
	const key = `${kind}|${path ?? ""}|${payload.mode ?? ""}`;
	const now = Date.now();
	// Duration segments are real slices of one sitting, not repeated clicks.
	if (payload.durMs == null) {
		const last = recent.get(key);
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

function clearSegmentTimer(): void {
	if (segmentTimer) {
		clearTimeout(segmentTimer);
		segmentTimer = null;
	}
}

function emitSegment(path: string, dur: number): void {
	if (dur < 1000) return;
	track("paper.blur", { path, durMs: dur });
	if (dur >= SESSION_MIN_MS) {
		track("paper.session", { path, durMs: dur });
	}
}

/** Keep a long sitting instead of dropping everything past 30 minutes. */
function rollFocusedSegments(now: number): void {
	if (!focused) return;
	while (now - focused.startedAt >= MAX_FOCUS_MS) {
		emitSegment(focused.path, MAX_FOCUS_MS);
		focused = {
			path: focused.path,
			startedAt: focused.startedAt + MAX_FOCUS_MS,
		};
	}
}

function armSegmentTimer(): void {
	clearSegmentTimer();
	if (!focused) return;
	const wait = Math.max(MAX_FOCUS_MS - (Date.now() - focused.startedAt), 0);
	segmentTimer = setTimeout(() => {
		segmentTimer = null;
		rollFocusedSegments(Date.now());
		armSegmentTimer();
	}, wait);
}

/** Pair focus/blur so only the active paper body accumulates reading time. */
export function notePaperFocus(absOrRelPath: string | null): void {
	const vault = getVaultPath();
	const path = absOrRelPath
		? (normalizePath(vault, absOrRelPath) ?? null)
		: null;
	if ((focused?.path ?? null) === path) return;
	const now = Date.now();
	if (focused) {
		rollFocusedSegments(now);
		emitSegment(focused.path, now - focused.startedAt);
	}
	focused = path ? { path, startedAt: now } : null;
	if (path) {
		track("paper.focus", { path });
		armSegmentTimer();
		return;
	}
	clearSegmentTimer();
}

export function startActivityTracking(
	resumePath?: () => string | null,
): () => void {
	if (started || typeof window === "undefined") return () => undefined;
	started = true;
	const onHide = () => {
		notePaperFocus(null);
		void flushActivity();
	};
	const onFocus = () => {
		const path = resumePath?.() ?? null;
		if (path) notePaperFocus(path);
	};
	window.addEventListener("blur", onHide);
	window.addEventListener("pagehide", onHide);
	window.addEventListener("beforeunload", onHide);
	window.addEventListener("focus", onFocus);
	return () => {
		window.removeEventListener("blur", onHide);
		window.removeEventListener("pagehide", onHide);
		window.removeEventListener("beforeunload", onHide);
		window.removeEventListener("focus", onFocus);
		if (flushTimer) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		clearSegmentTimer();
		started = false;
	};
}

export async function flushActivity(): Promise<void> {
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	if (flushing || buffer.length === 0) return;
	flushing = true;
	const batch = buffer
		.splice(0, buffer.length)
		.map(({ _key, _at, ...event }) => {
			void _key;
			void _at;
			return event;
		});
	try {
		await recordActivityEvents(batch);
	} catch (error) {
		logger.warn("activity flush failed", {
			error: errorText(error),
		});
	} finally {
		flushing = false;
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
	focused = null;
	clearSegmentTimer();
	if (flushTimer) {
		clearTimeout(flushTimer);
		flushTimer = null;
	}
	flushing = false;
	started = false;
}

export function pendingActivityCountForTests(): number {
	return buffer.length;
}
