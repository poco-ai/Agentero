/**
 * Row virtualization plus IDE-style reveal: expand ancestors of the active
 * document and scroll the matching row into view after tree refreshes.
 */
import { useVirtualizer, type Virtualizer } from "@tanstack/react-virtual";
import { type RefObject, useCallback, useEffect, useMemo, useRef } from "react";
import { scrollBehavior } from "@/lib/core/motion";
import { TRASH_VIRTUAL_PATH } from "@/lib/paper/api";
import { PLAZA_VIRTUAL_PATH } from "@/lib/plaza";
import { useUiScale } from "@/lib/settings";
import { isVirtualTreePath, pathKey } from "../tree-helpers";
import type { FlatRow } from "../types";

export type TreeReveal = {
	treeScrollRef: RefObject<HTMLDivElement | null>;
	rowVirtualizer: Virtualizer<HTMLDivElement, Element>;
};

/** Index of the row matching `target`, or -1. */
function findRowIndex(rows: FlatRow[], target: string): number {
	const targetKey = pathKey(target);
	return rows.findIndex((row) => {
		if (row.kind === "trash") return targetKey === pathKey(TRASH_VIRTUAL_PATH);
		if (row.kind === "plaza") return targetKey === pathKey(PLAZA_VIRTUAL_PATH);
		if (row.kind === "plazaSource")
			return targetKey === pathKey(row.source.path);
		if (row.kind === "node") return pathKey(row.node.path) === targetKey;
		return false;
	});
}

export function useTreeReveal({
	treeSelectedPath,
	flatRows,
	expandAncestorsOf,
	suppressAutoRevealRef,
}: {
	treeSelectedPath: string | undefined;
	flatRows: FlatRow[];
	expandAncestorsOf: (target: string) => void;
	suppressAutoRevealRef: RefObject<boolean>;
}): TreeReveal {
	const treeScrollRef = useRef<HTMLDivElement>(null);
	const uiScale = useUiScale();
	// Key by stable row id so insert/remove of the inline create draft does
	// not leave stale measured heights on recycled indexes (gap after create).
	const flatRowKeys = useMemo(() => flatRows.map((r) => r.key), [flatRows]);
	const rowVirtualizer = useVirtualizer({
		count: flatRows.length,
		getScrollElement: () => treeScrollRef.current,
		estimateSize: () => Math.round(28 * uiScale),
		getItemKey: (index) => flatRowKeys[index] ?? index,
		overscan: 15,
		// Defer ResizeObserver measure to the next frame so React 19 commits
		// (Paper Info mount, tree refresh) land before we read geometry.
		useAnimationFrameWithResizeObserver: true,
	});

	// Re-estimate rows only when the height estimate itself changes (ui scale).
	// The flattened set changes on expand/collapse/refresh, but stable row keys
	// keep measured heights valid — a full measure() there re-estimates every
	// row and re-fires first-measure scroll adjustments, which WebKit (no
	// native scroll anchoring) shows as row jitter on each toggle.
	// biome-ignore lint/correctness/useExhaustiveDependencies: measure() must re-run when the estimate changes
	useEffect(() => {
		rowVirtualizer.measure();
	}, [uiScale, rowVirtualizer]);

	/**
	 * WebKit can clamp the DOM `scrollTop` without firing `scroll` after ANY
	 * layout change (Paper Info mount, dock panel replace, layout preset, tree
	 * refresh). The virtualizer then keeps a stale offset and renders an empty
	 * window → the sidebar looks blank until the user scrolls. Self-heal: when
	 * rows exist but the virtualizer reports none, re-read the DOM offset (and
	 * clamp a too-large value) so the next render window is non-empty.
	 */
	const flatRowCount = flatRows.length;
	const resyncRafRef = useRef<number | null>(null);
	const resyncIfEmpty = useCallback(() => {
		if (resyncRafRef.current !== null) return;
		resyncRafRef.current = requestAnimationFrame(() => {
			resyncRafRef.current = null;
			const el = treeScrollRef.current;
			if (!el || flatRowCount === 0) return;
			if (rowVirtualizer.getVirtualItems().length > 0) return;
			const max = Math.max(0, el.scrollHeight - el.clientHeight);
			const offset = Math.min(el.scrollTop, max);
			if (offset !== el.scrollTop) el.scrollTop = offset;
			rowVirtualizer.scrollToOffset(offset);
		});
	}, [flatRowCount, rowVirtualizer]);

	useEffect(
		() => () => {
			if (resyncRafRef.current !== null) {
				cancelAnimationFrame(resyncRafRef.current);
			}
		},
		[],
	);

	// Any flat-row/selection change can leave the virtualizer one layout behind.
	// biome-ignore lint/correctness/useExhaustiveDependencies: rerun on row/selection changes
	useEffect(() => {
		resyncIfEmpty();
	}, [flatRows, treeSelectedPath, resyncIfEmpty]);

	// WebKit may clamp scrollTop without firing `scroll` when the tree viewport
	// HEIGHT changes (Paper Info opens/closes); re-sync the virtualizer from
	// the DOM then, or it keeps a stale offset and getVirtualItems() returns an
	// empty window → blank sidebar until the user scrolls.
	// Width-only changes (left-rail collapse/expand animation, manual sidebar
	// resize) must NOT write scrollTop: reading geometry mid-transition returns
	// clamped values, and a per-frame scrollToOffset + reconcile fight shows as
	// jitter. A rail collapse parks the tree at 0px width, where WebKit can
	// also drop scrollTop outright — remember the live position and restore it
	// when the rail reopens so the tree does not jump back to the top.
	useEffect(() => {
		const el = treeScrollRef.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		let lastWidth = el.clientWidth;
		let lastHeight = el.clientHeight;
		let savedScrollTop = el.scrollTop;
		const onScroll = () => {
			savedScrollTop = el.scrollTop;
		};
		el.addEventListener("scroll", onScroll, { passive: true });
		const ro = new ResizeObserver(() => {
			const width = el.clientWidth;
			const height = el.clientHeight;
			const reopened = lastWidth <= 0 && width > 0;
			const heightChanged = height !== lastHeight;
			lastWidth = width;
			lastHeight = height;
			if (width <= 0) return;
			if (reopened && el.scrollTop < savedScrollTop) {
				el.scrollTop = savedScrollTop;
			}
			if (heightChanged || reopened) {
				savedScrollTop = el.scrollTop;
				rowVirtualizer.scrollToOffset(el.scrollTop);
				resyncIfEmpty();
			}
		});
		ro.observe(el);
		return () => {
			ro.disconnect();
			el.removeEventListener("scroll", onScroll);
		};
	}, [rowVirtualizer, resyncIfEmpty]);

	const pendingRevealPathRef = useRef<string | null>(null);
	/** Target that armed the current reveal; guards against effect-identity churn. */
	const armedTargetRef = useRef<string | null>(null);
	/** Target already scrolled into view; a reveal is spent once it lands. */
	const revealedTargetRef = useRef<string | null>(null);

	// Every tree refresh rebuilds `byPathKey`, so `expandAncestorsOf` gets a new
	// identity and this effect re-runs. Compare by value: only a genuine target
	// change arms a reveal, otherwise background import stages would each scroll.
	useEffect(() => {
		if (!treeSelectedPath) return;
		if (armedTargetRef.current === treeSelectedPath) return;
		armedTargetRef.current = treeSelectedPath;
		revealedTargetRef.current = null;
		// New selection always re-enables auto-reveal (e.g. open paper).
		suppressAutoRevealRef.current = false;
		pendingRevealPathRef.current = treeSelectedPath;
		expandAncestorsOf(treeSelectedPath);
	}, [treeSelectedPath, expandAncestorsOf, suppressAutoRevealRef]);

	// After tree refresh (import / rescan), re-queue reveal only when the
	// selected path is not yet a visible flat row (parents collapsed, or the
	// node just appeared after magic-wand import).
	useEffect(() => {
		if (!treeSelectedPath || isVirtualTreePath(treeSelectedPath)) return;
		// Already landed on this row: later refreshes must not scroll again, and
		// an intentional collapse must stay collapsed.
		if (revealedTargetRef.current === treeSelectedPath) return;
		if (suppressAutoRevealRef.current) {
			// Consume once: intentional collapse must not re-expand ancestors.
			suppressAutoRevealRef.current = false;
			return;
		}
		if (findRowIndex(flatRows, treeSelectedPath) >= 0) return;
		pendingRevealPathRef.current = treeSelectedPath;
		expandAncestorsOf(treeSelectedPath);
	}, [treeSelectedPath, expandAncestorsOf, flatRows, suppressAutoRevealRef]);

	// treeSelectedPath: re-run when selection changes even if flatRows is unchanged
	// (path already visible / ancestors already expanded).
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional
	useEffect(() => {
		const target = pendingRevealPathRef.current;
		if (!target) return;
		const idx = findRowIndex(flatRows, target);
		if (idx < 0) return;

		pendingRevealPathRef.current = null;
		revealedTargetRef.current = target;
		// Double rAF: first for expand→flatRows layout, second for virtualizer measure.
		requestAnimationFrame(() => {
			requestAnimationFrame(() => {
				// VS Code `List.reveal` semantics: scroll the minimum needed and
				// leave rows that are already (partly) visible untouched — never
				// center. Centering makes every selection near the tree top drag
				// the whole list back to scrollTop 0.
				rowVirtualizer.scrollToIndex(idx, {
					align: "auto",
					behavior: scrollBehavior(),
				});
				resyncIfEmpty();
			});
		});
	}, [flatRows, rowVirtualizer, treeSelectedPath, resyncIfEmpty]);

	return { treeScrollRef, rowVirtualizer };
}
