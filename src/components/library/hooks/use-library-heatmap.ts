/**
 * Reading heatmaps for the papers library (title spines).
 *
 * A five-bucket cache (heatmaps / raw points / page counts / tried-keys /
 * vault tag) survives re-renders and background catalog refreshes; effect
 * order matters — the load effect (batch refresh) must stay declared before
 * the lazy page-count effect, which depends on both `heatmaps` state and
 * `virtualRows` (recomputed every scroll, by design).
 */
import type { VirtualItem } from "@tanstack/react-virtual";
import { useEffect, useRef, useState } from "react";
import type { PaperRow } from "@/components/library/library-row-utils";
import { logger } from "@/lib/core/logger";
import type { PaperMetadata } from "@/lib/paper";
import { listPaperPageCounts, savePaperPageCounts } from "@/lib/paper/api";
import {
	aggregateReadingHeatmap,
	heatmapCacheKey,
	loadReadingHeatmaps,
	type ReadingActivityPoint,
	type ReadingHeatmap,
} from "@/lib/paper/reading-heatmap";
import { getPdfPageCount } from "@/lib/pdf/page-count";
import { joinVaultPath } from "@/lib/vault";

export function useLibraryHeatmap({
	vaultPath,
	scopedPapers,
	active,
	rows,
	virtualRows,
}: {
	vaultPath: string | null;
	scopedPapers: PaperMetadata[];
	active: boolean;
	rows: PaperRow[];
	virtualRows: VirtualItem[];
}) {
	const [heatmaps, setHeatmaps] = useState<Map<string, ReadingHeatmap>>(
		() => new Map(),
	);

	/**
	 * Heatmap cache survives re-renders, tab switches, and background catalog
	 * refreshes (which replace `scopedPapers` identity without changing
	 * content). Refocusing the Library refreshes activity with one batch IPC
	 * instead of clearing the cache; raw points and page counts stay warm so
	 * re-activation never reopens PDFs (`getPdfPageCount` is expensive and
	 * only runs lazily for visible rows below).
	 */
	const heatmapCacheRef = useRef<{
		vault: string | null;
		heatmaps: Map<string, ReadingHeatmap>;
		/** Raw activity points — re-aggregated when a page count is discovered. */
		points: Map<string, ReadingActivityPoint[]>;
		/** Catalog-cached + freshly discovered page counts. */
		pageCounts: Map<string, number>;
		/** Keys where lazy page-count discovery already ran (no retry loop). */
		pageCountTried: Set<string>;
	}>({
		vault: null,
		heatmaps: new Map(),
		points: new Map(),
		pageCounts: new Map(),
		pageCountTried: new Set(),
	});
	const wasActiveRef = useRef(false);

	/** Load reading heatmaps for the current folder scope (full library or org folder). */
	useEffect(() => {
		const justActivated = active && !wasActiveRef.current;
		wasActiveRef.current = active;
		if (!active) return;
		const cache = heatmapCacheRef.current;
		if (cache.vault !== (vaultPath ?? null)) {
			cache.vault = vaultPath ?? null;
			cache.heatmaps = new Map();
			cache.points = new Map();
			cache.pageCounts = new Map();
			cache.pageCountTried = new Set();
		}
		if (!vaultPath || !scopedPapers.length) {
			setHeatmaps(new Map());
			return;
		}

		// Paint from cache immediately; the batch below refreshes in place.
		const cachedNow = new Map<string, ReadingHeatmap>();
		const missing: PaperMetadata[] = [];
		for (const p of scopedPapers) {
			const key = heatmapCacheKey(p);
			const hit = cache.heatmaps.get(key);
			if (hit) cachedNow.set(key, hit);
			else missing.push(p);
		}
		if (cachedNow.size > 0) setHeatmaps(cachedNow);

		// Re-activation refreshes every scoped paper to pick up fresh PDF
		// activity (2 IPC total); otherwise only papers not seen before.
		const target = justActivated ? scopedPapers : missing;
		if (!target.length) return;

		let cancelled = false;
		void (async () => {
			const startedAt = performance.now();
			// Persisted page counts (catalog `pdf_page_counts`) normalize bins
			// without opening any PDF.
			const pageCounts = await listPaperPageCounts(vaultPath);
			if (cancelled) return;
			for (const [key, count] of pageCounts) cache.pageCounts.set(key, count);
			const { heatmaps: fresh, points } = await loadReadingHeatmaps(
				vaultPath,
				target,
				{ pageCounts: cache.pageCounts },
			);
			if (cancelled) return;
			for (const [key, heat] of fresh) cache.heatmaps.set(key, heat);
			for (const [key, pts] of points) cache.points.set(key, pts);
			setHeatmaps((prev) => {
				const next = new Map(prev);
				for (const [key, heat] of fresh) next.set(key, heat);
				return next;
			});
			logger.debug("library heatmap refresh", {
				papers: target.length,
				ipc: 2,
				duration_ms: Math.round(performance.now() - startedAt),
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [vaultPath, scopedPapers, active]);

	/**
	 * Lazy page-count discovery: opening a whole PDF just to count pages is
	 * expensive, so it only runs for rows that are actually visible, have
	 * reading activity, and lack a cached count (catalog `pdf_page_counts`).
	 * Discovered counts persist to the catalog, so this is one-time per paper.
	 * `pageCountTried` dedupes across overlapping scroll-triggered runs.
	 */
	useEffect(() => {
		if (!active || !vaultPath) return;
		const cache = heatmapCacheRef.current;
		const targets: string[] = [];
		for (const vr of virtualRows) {
			const paper = rows[vr.index]?.paper;
			if (!paper?.path) continue;
			const key = heatmapCacheKey(paper);
			if (cache.pageCounts.has(key) || cache.pageCountTried.has(key)) continue;
			// Only papers with visible activity benefit from a real page extent
			// (also re-triggers this effect once the batch load lands).
			const heat = heatmaps.get(key);
			if (!heat || heat.total <= 0) continue;
			cache.pageCountTried.add(key);
			targets.push(key);
		}
		if (!targets.length) return;
		void (async () => {
			for (const key of targets) {
				// Cache identity outlives this effect; bail out on vault switch.
				if (heatmapCacheRef.current.vault !== vaultPath) return;
				const count = await getPdfPageCount(joinVaultPath(vaultPath, key));
				if (count == null || count <= 0) continue;
				cache.pageCounts.set(key, count);
				void savePaperPageCounts(vaultPath, new Map([[key, count]]));
				const points = cache.points.get(key);
				if (!points?.length) continue;
				const heat = aggregateReadingHeatmap(points, { pageCount: count });
				cache.heatmaps.set(key, heat);
				setHeatmaps((prev) => {
					const next = new Map(prev);
					next.set(key, heat);
					return next;
				});
				logger.debug("library heatmap page count discovered", {
					paper: key,
					pages: count,
				});
			}
		})();
	}, [active, vaultPath, rows, virtualRows, heatmaps]);

	return heatmaps;
}
