/**
 * Off-main-thread loader + cache for citation destination key maps.
 *
 * `buildCitationDestKeyMap` (pdf-lib) parses the entire PDF object tree with
 * no lazy loading — seconds of blocking on large papers. This module keeps the
 * viewer responsive by:
 *
 * 1. Running the parse in a dedicated entity-file worker (blob-URL workers can
 *    fail on Windows WebView2), transferring the buffer instead of cloning it.
 * 2. Reusing the PDF bytes the viewer tab already holds (EmbedPDF structured-
 *    clones them to its engine worker, so the tab buffer stays intact) — one
 *    memcpy instead of a second full disk read.
 * 3. Memoizing results per `pdfPath:byteLength`, so reopening the same paper
 *    never parses twice in a session.
 *
 * `@tauri-apps/plugin-fs` is unavailable inside workers, so file discovery and
 * the disk-read fallback stay on the main thread; only the CPU-bound parse
 * moves off it.
 */

import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { findLocalPdfPath, localFileToArrayBuffer } from "@/lib/paper";
import {
	buildPdfDestMaps,
	type PdfDestMaps,
} from "@/lib/pdf/citation-dest-keys";
import type {
	CitationDestKeysRequest,
	CitationDestKeysResponse,
} from "@/lib/pdf/citation-dest-keys.worker";

/** Max cached PDFs; each entry is a small coord → value string map. */
const CACHE_LIMIT = 16;

/** `pdfPath:byteLength` → parsed maps (promise, so concurrent loads dedupe). */
const cache = new Map<string, Promise<PdfDestMaps>>();

// ---- Worker transport ----

let worker: Worker | null = null;
/** Sticky: once the worker fails to spawn/load, parse on the main thread. */
let workerFailed = false;
let nextRequestId = 1;
const pending = new Map<
	number,
	{
		resolve: (maps: PdfDestMaps) => void;
		reject: (error: Error) => void;
	}
>();

function ensureWorker(): Worker | null {
	if (workerFailed) return null;
	if (worker) return worker;
	if (typeof Worker === "undefined") {
		workerFailed = true;
		return null;
	}
	try {
		worker = new Worker(
			new URL("./citation-dest-keys.worker.ts", import.meta.url),
			{ type: "module" },
		);
	} catch (error) {
		logger.warn("citation dest map: worker spawn failed", {
			error: errorText(error),
		});
		workerFailed = true;
		return null;
	}
	worker.onmessage = (event: MessageEvent<CitationDestKeysResponse>) => {
		const request = pending.get(event.data.id);
		if (!request) return;
		pending.delete(event.data.id);
		if (event.data.ok) {
			request.resolve({
				cites: new Map(event.data.cites),
				crossrefs: new Map(event.data.crossrefs),
				crossrefKinds: new Map(event.data.crossrefKinds),
				crossrefLabels: new Map(event.data.crossrefLabels),
				crossrefLinks: event.data.crossrefLinks ?? [],
				citationLinks: event.data.citationLinks ?? [],
				pageOrigins: event.data.pageOrigins ?? [],
				otherNamedLinks: event.data.otherNamedLinks ?? [],
			});
		} else request.reject(new Error(event.data.error));
	};
	worker.onerror = (event) => {
		// Worker module failed to load/run: fail in-flight requests and fall
		// back to main-thread parsing for future documents.
		const error = new Error(event.message || "citation worker error");
		logger.warn("citation dest map: worker error", { error: error.message });
		for (const request of pending.values()) request.reject(error);
		pending.clear();
		worker?.terminate();
		worker = null;
		workerFailed = true;
	};
	return worker;
}

/**
 * Parse hyperref named destinations without blocking the main thread. The
 * buffer is transferred (zero-copy) — the caller hands over ownership. Falls
 * back to a main-thread parse when workers are unavailable (tests, spawn
 * failure).
 */
function parsePdfDestMaps(bytes: ArrayBuffer): Promise<PdfDestMaps> {
	const w = ensureWorker();
	if (!w) return buildPdfDestMaps(bytes);
	const id = nextRequestId++;
	return new Promise<PdfDestMaps>((resolve, reject) => {
		pending.set(id, { resolve, reject });
		const request: CitationDestKeysRequest = { id, bytes };
		w.postMessage(request, [bytes]);
	});
}

/**
 * Cache wrapper: one parse per key, failures evicted so they can be retried.
 * Exported for tests (worker + Tauri fs are unavailable under vitest).
 */
export function getPdfDestMapsCached(
	key: string,
	source: "viewer-bytes" | "disk",
	parse: () => Promise<PdfDestMaps>,
): Promise<PdfDestMaps> {
	const hit = cache.get(key);
	if (hit) {
		logger.debug("citation dest map: cache hit", { key });
		return hit;
	}
	const started = performance.now();
	const promise = parse().then((maps) => {
		logger.debug("citation dest map: built", {
			key,
			source,
			cites: maps.cites.size,
			crossrefs: maps.crossrefs.size,
			crossrefKinds: maps.crossrefKinds.size,
			duration_ms: Math.round(performance.now() - started),
		});
		return maps;
	});
	cache.set(key, promise);
	// Bounded FIFO: maps are tiny, this only guards a pathological session.
	while (cache.size > CACHE_LIMIT) {
		const oldest = cache.keys().next().value;
		if (oldest === undefined) break;
		cache.delete(oldest);
	}
	promise.catch(() => cache.delete(key));
	return promise;
}

/** Test-only: reset the memoized maps. */
export function clearCitationDestKeyMapCache(): void {
	cache.clear();
}

/** Upper bound before the deferred dest-map build runs anyway. */
const DEST_MAP_IDLE_TIMEOUT_MS = 2000;
/** Fallback delay when `requestIdleCallback` is unavailable (WebKit). */
const DEST_MAP_FALLBACK_DELAY_MS = 500;

/**
 * Run `fn` when the main thread is idle (bounded), so the map build never
 * competes with the PDF-open critical path (first paint, scroll, selection).
 * Returns a canceller.
 */
function scheduleIdle(fn: () => void): () => void {
	if (typeof requestIdleCallback === "function") {
		const id = requestIdleCallback(fn, { timeout: DEST_MAP_IDLE_TIMEOUT_MS });
		return () => cancelIdleCallback(id);
	}
	const id = setTimeout(fn, DEST_MAP_FALLBACK_DELAY_MS);
	return () => clearTimeout(id);
}

export type SchedulePdfDestMapsBuildOptions = {
	paperAbsPath: string | null;
	/**
	 * Viewer bytes read when the idle slot actually fires, so a late bytes
	 * prop never re-triggers the effect but is still reused.
	 */
	viewerBytes: () => ArrayBuffer | null;
	/** Cache key for remote papers (no local path to key on). */
	documentId?: string | null;
	/** Non-fatal warn label used when the build rejects. */
	warnLabel: string;
	onMaps: (maps: PdfDestMaps) => void;
};

/**
 * Deferred `loadPdfDestMaps` for the hover-preview hooks: schedule at idle,
 * drop the result when the disposer ran (document switch / unmount), warn
 * (non-fatal — hover previews simply do not resolve) on failure. Returns the
 * disposer for the effect cleanup.
 */
export function schedulePdfDestMapsBuild({
	paperAbsPath,
	viewerBytes,
	documentId,
	warnLabel,
	onMaps,
}: SchedulePdfDestMapsBuildOptions): () => void {
	let cancelled = false;
	const cancelIdle = scheduleIdle(() => {
		void loadPdfDestMaps({
			paperAbsPath,
			viewerBytes: viewerBytes(),
			documentId,
		})
			.then((maps) => {
				if (cancelled || !maps) return;
				onMaps(maps);
			})
			.catch((error: unknown) => {
				logger.warn(warnLabel, { error: errorText(error) });
			});
	});
	return () => {
		cancelled = true;
		cancelIdle();
	};
}

export type LoadPdfDestMapsOptions = {
	/** Absolute paper folder of the open PDF. Null for remote papers. */
	paperAbsPath?: string | null;
	/**
	 * PDF bytes the viewer already holds (`tab.pdfBytes`). When present (and
	 * not detached) they are copied instead of re-reading the whole file from
	 * disk; the copy is what gets transferred to the parser worker, so the
	 * viewer's buffer is never detached.
	 */
	viewerBytes?: ArrayBuffer | null;
	/**
	 * Stable document id for remote-paper cache keys. Local papers fall back to
	 * the resolved PDF path, so this is only required when `paperAbsPath` is null.
	 */
	documentId?: string | null;
};

/**
 * Resolve the paper's local PDF and build (or reuse) its destination maps
 * (citations + cross-references). Returns null when no local PDF exists and no
 * viewer bytes were supplied. Rejections propagate so the caller decides how
 * loudly to fail.
 */
export async function loadPdfDestMaps({
	paperAbsPath,
	viewerBytes,
	documentId,
}: LoadPdfDestMapsOptions): Promise<PdfDestMaps | null> {
	const reusable =
		viewerBytes && viewerBytes.byteLength > 0 ? viewerBytes : null;

	if (paperAbsPath) {
		const pdfPath = await findLocalPdfPath(paperAbsPath);
		if (!pdfPath && !reusable) return null;

		if (reusable) {
			return getPdfDestMapsCached(
				`${pdfPath ?? paperAbsPath}:${reusable.byteLength}`,
				"viewer-bytes",
				// Copy before transferring so the worker cannot detach the viewer's
				// buffer (a memcpy beats a second full disk read).
				() => parsePdfDestMaps(reusable.slice(0)),
			);
		}

		if (!pdfPath) return null;
		const bytes = await localFileToArrayBuffer(pdfPath);
		if (!bytes) return null;
		return getPdfDestMapsCached(
			`${pdfPath}:${bytes.byteLength}`,
			"disk",
			// Freshly read, exclusively owned: transfer without copying.
			() => parsePdfDestMaps(bytes),
		);
	}

	if (!reusable) return null;
	const key = documentId?.trim()
		? `remote:${documentId}:${reusable.byteLength}`
		: `remote:${reusable.byteLength}`;
	return getPdfDestMapsCached(
		key,
		"viewer-bytes",
		// Copy before transferring so the worker cannot detach the viewer's buffer.
		() => parsePdfDestMaps(reusable.slice(0)),
	);
}
