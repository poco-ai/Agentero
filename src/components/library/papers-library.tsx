/**
 * Vault library: table of all papers from catalog.sqlite (display only).
 * Click column headers to sort ascending / descending.
 * Title-header inline search + tags-header filter (no separate toolbar).
 * Single-click a row to open the paper (deferred so double-click can cancel);
 * double-click a cell to copy that field.
 * Multi-select: leading checkbox column, marquee drag over rows, and a batch
 * context menu / floating action bar once more than one row is selected.
 * Reading heat: title text background as a left→right spine (doc start→end).
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { RefreshCw } from "lucide-react";
import type { MouseEvent, ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCellCopy } from "@/components/library/hooks/use-cell-copy";
import { useLibraryHeatmap } from "@/components/library/hooks/use-library-heatmap";
import { useLibraryMarquee } from "@/components/library/hooks/use-library-marquee";
import { useLibraryPreview } from "@/components/library/hooks/use-library-preview";
import { useLibrarySelection } from "@/components/library/hooks/use-library-selection";
import { resolveColumnWidths } from "@/components/library/library-column-widths";
import { getColumnMeta } from "@/components/library/library-columns";
import { LibraryCopyDialog } from "@/components/library/library-copy-dialog";
import { LibraryPaperRow } from "@/components/library/library-paper-row";
import { LibraryPdfDropSurface } from "@/components/library/library-pdf-drop-surface";
import { LibraryRowMenu } from "@/components/library/library-row-menu";
import {
	buildPaperRow,
	type CellCtx,
	type CellT,
	comparePaperRows,
	reorderColumns,
	type SortDir,
	type SortKey,
	toggleColumnVisibility,
} from "@/components/library/library-row-utils";
import { paperSelectionKey } from "@/components/library/library-selection";
import { LibrarySelectionBar } from "@/components/library/library-selection-bar";
import { LibraryTableHeader } from "@/components/library/library-table-header";
import { Button } from "@/components/ui/button";
import { useWritingStore } from "@/hooks/use-app-stores";
import { useDebouncedCallback } from "@/hooks/use-debounce";
import { presentAgentComposer } from "@/lib/agent/composer-focus";
import { broadcastAgentAttachContext } from "@/lib/agent/context-attach";
import { cn } from "@/lib/core/utils";
import type { PaperLibraryRow, PaperMetadata } from "@/lib/paper";
import { filterPapersByScope } from "@/lib/paper/api";
import { loadCustomProperties } from "@/lib/paper/custom-properties-store";
import {
	copyLibraryPapersTo,
	refreshPaperMetadata,
	syncLibraryPublication,
} from "@/lib/paper/library-actions";
import { heatmapCacheKey } from "@/lib/paper/reading-heatmap";
import { editablePaperTags, type PaperTag } from "@/lib/paper/tags";
import {
	DEFAULT_LIBRARY_COLUMNS,
	type LibraryColumnPref,
	useUiScale,
} from "@/lib/settings";
import { allowsNativeSelectAll } from "@/lib/shell/native-select-all";
import { joinVaultPath } from "@/lib/vault";
import { trashPathsAndNotify } from "@/lib/vault/actions";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";

export type PapersLibraryProps = {
	/** Full catalog list (or pre-scoped); further filtered by `scopePath`. */
	papers: PaperLibraryRow[];
	/** Vault root; required to load per-paper reading heatmaps. */
	vaultPath?: string | null;
	/** When the Library tab is focused — reload heatmaps (after PDF activity). */
	active?: boolean;
	loading?: boolean;
	query?: string;
	/** Controlled search string (lives in App so palette/other callers can clear it). */
	onQueryChange?: (query: string) => void;
	/**
	 * Vault-relative folder scope (e.g. `papers/nlp`).
	 * Null/empty = full library. Filters by catalog `path` prefix (recursive).
	 */
	scopePath?: string | null;
	onOpenPaper: (paper: PaperMetadata) => void;
	/**
	 * Column order + visibility (persisted in settings). When omitted, all
	 * columns show in canonical order.
	 */
	columns?: LibraryColumnPref[];
	/** Persist a new column layout (reorder / show-hide / reset). */
	onColumnsChange?: (columns: LibraryColumnPref[]) => void;
	/** Rebuild the catalog from papers/ on disk (empty-state recovery). */
	onRescan?: () => void;
	rescanning?: boolean;
	className?: string;
};

/**
 * Delay before a keystroke commits to the shared library query.
 * Keeps typing local to the input so each key does not re-filter/sort the
 * full catalog (and re-render workspace subscribers of `query`).
 */
const SEARCH_DEBOUNCE_MS = 250;
/** Hide header search/actions while scrolling; restore after this idle gap. */
const HEADER_SCROLL_IDLE_MS = 450;
/** Leading selection checkbox column width (rem) — header, colgroup, rows. */
const SELECTION_COL_REM = 2;
/** Trailing custom-property "add column" cell width (rem). */
const ACTIONS_COL_REM = 2.25;

/** Radix dialog/menu/popover is open → app-level shortcuts must not fight it. */
function blockingOverlayOpen(): boolean {
	if (typeof document === "undefined") return false;
	return Boolean(
		document.querySelector(
			"[data-radix-popper-content-wrapper] [data-state='open'], [role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']",
		),
	);
}

export function PapersLibrary({
	papers,
	vaultPath = null,
	active = true,
	loading,
	query = "",
	onQueryChange,
	scopePath = null,
	onOpenPaper,
	columns = DEFAULT_LIBRARY_COLUMNS,
	onColumnsChange,
	onRescan,
	rescanning,
	className,
}: PapersLibraryProps) {
	const reading = useWritingStore((s) => s.surface === "reading");
	const { t: tRaw, i18n } = useTranslation("sidebar");
	/** Column renderers take plain string keys; cast off strict resource unions. */
	const t = tRaw as unknown as CellT;
	const [sortKey, setSortKey] = useState<SortKey>("title");
	const [sortDir, setSortDir] = useState<SortDir>("asc");
	/** Selected tag names for header filter (OR: paper matches if it has any). */
	const [tagFilter, setTagFilter] = useState<string[]>([]);

	/**
	 * Local mirror of `query`: keystrokes filter the (precomputed) rows here
	 * immediately, but only commit to the shared query after a debounce so
	 * workspace subscribers are not re-rendered on every key.
	 */
	const [inputValue, setInputValue] = useState(query);
	const commitSearch = useDebouncedCallback(
		(value: string) => onQueryChange?.(value),
		SEARCH_DEBOUNCE_MS,
	);

	useEffect(() => {
		setInputValue(query);
		commitSearch.cancel();
	}, [query, commitSearch]);

	useEffect(() => () => commitSearch.cancel(), [commitSearch]);

	// Load the custom fields used by Paper Info for the active Library.
	useEffect(() => {
		if (active && vaultPath) void loadCustomProperties(vaultPath);
	}, [active, vaultPath]);

	const onSearchInputChange = useCallback(
		(value: string) => {
			setInputValue(value);
			commitSearch(value);
		},
		[commitSearch],
	);

	const handleSort = useCallback(
		(key: SortKey) => {
			if (key === sortKey) {
				setSortDir((d) => (d === "asc" ? "desc" : "asc"));
				return;
			}
			setSortKey(key);
			// Date / citation count default to newest/highest first; text columns ascending
			setSortDir(
				key === "date" || key === "addedAt" || key === "citations"
					? "desc"
					: "asc",
			);
		},
		[sortKey],
	);

	const { onCellCopy, onRowClick, openPaperFromRow } = useCellCopy({
		t,
		onOpenPaper,
	});

	const canEditMeta =
		Boolean(vaultPath) && !isRemoteVaultHandle(vaultPath ?? "");

	/** Folder scope first (cheap path-prefix filter on in-memory catalog). */
	const scopedPapers = useMemo(
		() => filterPapersByScope(papers, scopePath),
		[papers, scopePath],
	);

	/** Ordered, visible columns (title stays as a safety fallback). */
	const visibleColumns = useMemo(() => {
		const vis = columns.filter((c) => c.visible);
		return vis.length ? vis : columns.filter((c) => c.key === "title");
	}, [columns]);
	const [viewportRem, setViewportRem] = useState(56.25);
	const [resizing, setResizing] = useState<number[] | null>(null);
	const columnWidths = useMemo(
		() =>
			resizing ??
			resolveColumnWidths(
				visibleColumns,
				viewportRem,
				(col) => getColumnMeta(col.key).widthWeight,
			),
		[resizing, visibleColumns, viewportRem],
	);
	// PERF: stable identity keeps the memoized header from re-rendering on
	// unrelated parent renders; widths are captured per resize render.
	const resizeColumn = useCallback(
		(key: SortKey, width: number | null, commit: boolean) => {
			if (width === null) {
				setResizing(null);
				return;
			}
			// Freeze the other visible columns so every separator follows the pointer 1:1.
			const widths = columnWidths.map((value, index) =>
				visibleColumns[index].key === key ? width : value,
			);
			setResizing(commit ? null : widths);
			if (commit) {
				onColumnsChange?.(
					columns.map((col) => {
						const index = visibleColumns.findIndex(
							(visible) => visible.key === col.key,
						);
						return index < 0 ? col : { ...col, widthRem: widths[index] };
					}),
				);
			}
		},
		[columnWidths, visibleColumns, columns, onColumnsChange],
	);

	const toggleColumn = useCallback(
		(key: SortKey) => {
			if (!onColumnsChange || key === "title") return;
			onColumnsChange(toggleColumnVisibility(columns, key));
		},
		[columns, onColumnsChange],
	);

	const resetColumns = useCallback(() => {
		onColumnsChange?.(DEFAULT_LIBRARY_COLUMNS.map((c) => ({ ...c })));
	}, [onColumnsChange]);

	const handleColumnReorder = useCallback(
		(fromKey: SortKey, toKey: SortKey) => {
			if (!onColumnsChange || !fromKey) return;
			onColumnsChange(reorderColumns(columns, fromKey, toKey));
		},
		[columns, onColumnsChange],
	);

	const canSyncPublication =
		Boolean(vaultPath) && !isRemoteVaultHandle(vaultPath);
	const handleSyncPublication = useCallback(() => {
		void syncLibraryPublication(vaultPath, scopedPapers);
	}, [vaultPath, scopedPapers]);

	const handleRefreshPaperMetadata = useCallback(
		(paper: PaperMetadata) => {
			void refreshPaperMetadata(vaultPath, paper);
		},
		[vaultPath],
	);

	const normalizedQuery = (inputValue ?? "").trim().toLocaleLowerCase();
	const tagFilterSet = useMemo(() => new Set(tagFilter), [tagFilter]);

	/** Unique tags in the current folder scope (for the tags-column filter menu). */
	const availableTags = useMemo(() => {
		const byName = new Map<string, PaperTag>();
		for (const p of scopedPapers) {
			for (const tag of editablePaperTags(p.tags)) {
				if (!byName.has(tag.name)) byName.set(tag.name, tag);
			}
		}
		return [...byName.values()].sort((a, b) =>
			a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
		);
	}, [scopedPapers]);

	/** Drop filter selections that no longer exist in scope. */
	useEffect(() => {
		if (!tagFilter.length) return;
		const names = new Set(availableTags.map((t) => t.name));
		const next = tagFilter.filter((n) => names.has(n));
		if (next.length !== tagFilter.length) setTagFilter(next);
	}, [availableTags, tagFilter]);

	const toggleTagFilter = useCallback((name: string) => {
		setTagFilter((prev) =>
			prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
		);
	}, []);

	// PERF: stable identity for the memoized header.
	const clearTagFilter = useCallback(() => setTagFilter([]), []);

	/** Coerce tags + sort keys once per paper list change (not per keystroke). */
	const indexedRows = useMemo(
		() => scopedPapers.map(buildPaperRow),
		[scopedPapers],
	);

	/** Keystroke-level work is filter + sort over precomputed rows only. */
	const rows = useMemo(() => {
		let filtered = indexedRows;
		if (normalizedQuery) {
			filtered = filtered.filter((row) =>
				row.searchText.includes(normalizedQuery),
			);
		}
		if (tagFilterSet.size > 0) {
			filtered = filtered.filter((row) =>
				row.tags.some((tag) => tagFilterSet.has(tag.name)),
			);
		}
		const copy = [...filtered];
		copy.sort((a, b) => comparePaperRows(a, b, sortKey, sortDir));
		return copy;
	}, [indexedRows, normalizedQuery, tagFilterSet, sortKey, sortDir]);

	/** Visible row order (sorted + filtered) — the universe selection lives in. */
	const order = useMemo(
		() => rows.map((row) => paperSelectionKey(row.paper)),
		[rows],
	);
	const {
		keys: selectedKeys,
		count: selectedCount,
		allSelected,
		someSelected,
		selectRow,
		applyDrag,
		selectAll,
		clear: clearSelection,
		prepareContext,
		beginDrag,
		cancelDrag,
	} = useLibrarySelection(order);
	/**
	 * Latest rows / selection for callbacks that must stay identity-stable —
	 * a marquee drag re-renders this table every frame, and unstable props
	 * would re-render every visible row with it.
	 */
	const rowsRef = useRef(rows);
	rowsRef.current = rows;
	const selectedKeysRef = useRef(selectedKeys);
	selectedKeysRef.current = selectedKeys;
	const selectedCountRef = useRef(selectedCount);
	selectedCountRef.current = selectedCount;
	/** Virtualizer index → selection key (stable per rendered row order). */
	const keyForIndex = useCallback(
		(index: number) => order[index] ?? "",
		[order],
	);

	const previewPaths = useMemo(
		() =>
			new Set(rows.flatMap(({ paper }) => (paper.path ? [paper.path] : []))),
		[rows],
	);
	const previewPaper = useLibraryPreview({
		active: active && reading,
		vaultPath,
		scopePath,
		paths: previewPaths,
	});

	// Reorder cue: replay a quick fade when the user re-sorts or changes tag
	// filters. Deliberately excludes the search query — per-keystroke remounts
	// would flicker (high-frequency input, motion-15).
	const reorderKey = useMemo(
		() => `${sortKey}:${sortDir}:${tagFilter.join(",")}`,
		[sortKey, sortDir, tagFilter],
	);

	const scrollRef = useRef<HTMLDivElement | null>(null);
	const detachScrollRef = useRef<(() => void) | null>(null);
	/** True only while the table is scrolling; idle restores search/actions. */
	const [headerCompact, setHeaderCompact] = useState(false);
	const {
		onPointerDown: onMarqueePointerDown,
		overlayRef: marqueeOverlayRef,
		dragging: marqueeDragging,
		isDragging: marqueeIsDragging,
		didJustDrag: marqueeDidJustDrag,
	} = useLibraryMarquee({
		scrollRef,
		keyForIndex,
		onSelect: applyDrag,
		onDragStart: beginDrag,
		onCancel: cancelDrag,
		enabled: active,
	});
	/**
	 * Selection mode: the checkbox column only exists while a marquee is being
	 * drawn or rows are selected. Inside it, a row click toggles instead of
	 * opening, so the table reads exactly like before until you drag.
	 */
	const selectionActive = marqueeDragging || selectedCount > 0;
	/** Bind scroll listener when the table scroller mounts (after loading). */
	const setScrollEl = useCallback(
		(el: HTMLDivElement | null) => {
			detachScrollRef.current?.();
			detachScrollRef.current = null;
			scrollRef.current = el;
			if (!el) {
				setHeaderCompact(false);
				return;
			}
			let idleTimer: ReturnType<typeof setTimeout> | null = null;
			const onScroll = () => {
				// A marquee drag scrolls the list itself: keep the header steady and
				// leave the (suppressed) hover preview alone.
				if (marqueeIsDragging()) return;
				// Cancel pending hover when rows move, but retain the current preview.
				previewPaper.cancel();
				setHeaderCompact((prev) => (prev ? prev : true));
				if (idleTimer) clearTimeout(idleTimer);
				idleTimer = setTimeout(() => {
					idleTimer = null;
					setHeaderCompact(false);
				}, HEADER_SCROLL_IDLE_MS);
			};
			const updateWidth = () =>
				setViewportRem(
					el.clientWidth /
						Number.parseFloat(
							getComputedStyle(el.ownerDocument.documentElement).fontSize,
						),
				);
			const observer = new ResizeObserver(updateWidth);
			observer.observe(el);
			observer.observe(el.ownerDocument.documentElement);
			updateWidth();
			el.addEventListener("scroll", onScroll, { passive: true });
			detachScrollRef.current = () => {
				if (idleTimer) clearTimeout(idleTimer);
				observer.disconnect();
				el.removeEventListener("scroll", onScroll);
			};
		},
		[previewPaper, marqueeIsDragging],
	);
	useEffect(
		() => () => {
			detachScrollRef.current?.();
			detachScrollRef.current = null;
		},
		[],
	);
	const uiScale = useUiScale();
	useEffect(() => {
		if (scrollRef.current)
			setViewportRem(scrollRef.current.clientWidth / (16 * uiScale));
	}, [uiScale]);
	const rowVirtualizer = useVirtualizer({
		count: rows.length,
		getScrollElement: () => scrollRef.current,
		estimateSize: () => Math.round(52 * uiScale),
		overscan: 12,
	});

	const virtualRows = rowVirtualizer.getVirtualItems();
	const totalSize = rowVirtualizer.getTotalSize();
	const paddingTop = virtualRows.length > 0 ? virtualRows[0].start : 0;
	const paddingBottom =
		virtualRows.length > 0
			? totalSize - virtualRows[virtualRows.length - 1].end
			: 0;

	const heatmaps = useLibraryHeatmap({
		vaultPath,
		scopedPapers,
		active,
		rows,
		virtualRows,
	});

	/** Stable t + onCellCopy pair shared by every memoized row. */
	const cellCtx = useMemo<Pick<CellCtx, "t" | "onCellCopy">>(
		() => ({ t, onCellCopy }),
		[t, onCellCopy],
	);

	/** Selected papers, resolved on action only (never per marquee frame). */
	const collectSelectedPapers = useCallback(
		() =>
			rowsRef.current
				.filter((row) =>
					selectedKeysRef.current.has(paperSelectionKey(row.paper)),
				)
				.map((row) => row.paper),
		[],
	);

	const absPathsForPapers = useCallback(
		(papers: PaperLibraryRow[]) =>
			papers
				.map((paper) =>
					paper.path && vaultPath ? joinVaultPath(vaultPath, paper.path) : null,
				)
				.filter((path): path is string => Boolean(path)),
		[vaultPath],
	);

	const addPapersToChat = useCallback(
		(papers: PaperLibraryRow[]) => {
			const paths = absPathsForPapers(papers);
			if (!paths.length) return;
			broadcastAgentAttachContext(paths);
			presentAgentComposer();
		},
		[absPathsForPapers],
	);

	/** Papers pending "copy to folder" (dialog open while non-null). */
	const [copyPapers, setCopyPapers] = useState<PaperLibraryRow[] | null>(null);
	const openCopyDialog = useCallback((papers: PaperLibraryRow[]) => {
		if (papers.length) setCopyPapers(papers);
	}, []);
	const confirmCopy = useCallback(
		async (destParentRel: string) => {
			const papers = copyPapers ?? [];
			setCopyPapers(null);
			await copyLibraryPapersTo(papers, destParentRel);
		},
		[copyPapers],
	);

	const deletePapers = useCallback(
		(papers: PaperLibraryRow[]) => {
			const paths = absPathsForPapers(papers);
			if (!paths.length) return;
			void trashPathsAndNotify(paths);
			clearSelection();
		},
		[absPathsForPapers, clearSelection],
	);

	/** Row press: selection mode toggles, everything else keeps open-on-click. */
	const handleRowClick = useCallback(
		(event: MouseEvent<HTMLTableRowElement>, paper: PaperMetadata) => {
			if (marqueeDidJustDrag()) return;
			if (selectionActive) {
				// Inside selection mode the whole row is the toggle; the checkbox
				// itself stops propagation. Double-click still copies a cell.
				selectRow(paperSelectionKey(paper), { shift: event.shiftKey });
				return;
			}
			if (event.shiftKey || event.metaKey || event.ctrlKey) {
				selectRow(paperSelectionKey(paper), { shift: event.shiftKey });
				return;
			}
			onRowClick(event, paper);
		},
		[marqueeDidJustDrag, onRowClick, selectRow, selectionActive],
	);

	const handleToggleSelected = useCallback(
		(paper: PaperMetadata, mods: { shift: boolean }) => {
			selectRow(paperSelectionKey(paper), mods);
		},
		[selectRow],
	);

	const handleToggleAll = useCallback(
		(next: boolean) => {
			if (next) selectAll();
			else clearSelection();
		},
		[clearSelection, selectAll],
	);

	/** Hover preview is noise while a marquee drag sweeps across the rows. */
	const handleHoverPaper = useCallback(
		(relPath: string | null) => {
			if (marqueeIsDragging()) return;
			previewPaper(relPath);
		},
		[marqueeIsDragging, previewPaper],
	);

	/** Clicking empty table space drops the selection (like the file tree). */
	const handleScrollAreaClick = useCallback(
		(event: MouseEvent<HTMLDivElement>) => {
			if (marqueeDidJustDrag() || selectedCountRef.current === 0) return;
			const target = event.target as HTMLElement | null;
			if (!target) return;
			if (target.closest("tr[data-index]") || target.closest("thead")) return;
			clearSelection();
		},
		[clearSelection, marqueeDidJustDrag],
	);

	// ⌘A / Delete / Esc on the library surface: kept out of text fields and
	// open menus/dialogs so typing and other shortcuts keep working.
	useEffect(() => {
		if (!active) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (blockingOverlayOpen() || marqueeIsDragging()) return;
			const typing = allowsNativeSelectAll(event.target);
			if (
				(event.metaKey || event.ctrlKey) &&
				!event.shiftKey &&
				!event.altKey &&
				event.key.toLowerCase() === "a"
			) {
				if (typing) return;
				event.preventDefault();
				selectAll();
				return;
			}
			if (typing || event.defaultPrevented) return;
			if (event.key === "Escape") {
				if (selectedCountRef.current === 0) return;
				event.preventDefault();
				clearSelection();
				return;
			}
			if (
				(event.key === "Delete" || event.key === "Backspace") &&
				selectedCountRef.current > 0
			) {
				event.preventDefault();
				deletePapers(collectSelectedPapers());
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [
		active,
		clearSelection,
		collectSelectedPapers,
		deletePapers,
		marqueeIsDragging,
		selectAll,
	]);

	const filtering = normalizedQuery.length > 0 || tagFilterSet.size > 0;
	const tagFilterActive = tagFilterSet.size > 0;

	let body: ReactNode;
	if (loading) {
		body = (
			<div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground text-sm">
				{t("papersLibrary.loading")}
			</div>
		);
	} else {
		const empty = rows.length === 0;
		body = (
			<>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: scroll surface; rows and the header own the real controls */}
				{/* biome-ignore lint/a11y/useKeyWithClickEvents: Escape clears the selection from the keyboard */}
				<div
					ref={setScrollEl}
					onPointerDown={onMarqueePointerDown}
					onClick={handleScrollAreaClick}
					className={cn(
						"agentero-scroll-both relative min-w-0",
						empty ? "h-auto" : "min-h-0 flex-1",
					)}
				>
					{/* Fixed weights keep the table stable while content and rows change. */}
					<table
						className="table-fixed border-collapse text-left text-sm"
						style={{
							width: `${columnWidths.reduce((sum, width) => sum + width, 0) + (selectionActive ? SELECTION_COL_REM : 0) + ACTIONS_COL_REM}rem`,
						}}
					>
						<colgroup>
							{selectionActive ? (
								<col style={{ width: `${SELECTION_COL_REM}rem` }} />
							) : null}
							{visibleColumns.map((col, index) => (
								<col
									key={col.key}
									style={{
										width: `${columnWidths[index]}rem`,
									}}
								/>
							))}
							<col style={{ width: `${ACTIONS_COL_REM}rem` }} />
						</colgroup>
						<LibraryTableHeader
							t={t}
							columns={columns}
							visibleColumns={visibleColumns}
							sortKey={sortKey}
							sortDir={sortDir}
							onSort={handleSort}
							compact={headerCompact}
							searchEnabled={Boolean(onQueryChange)}
							inputValue={inputValue}
							onInputChange={onSearchInputChange}
							canSyncPublication={canSyncPublication}
							onSyncPublication={handleSyncPublication}
							availableTags={availableTags}
							tagFilterSet={tagFilterSet}
							tagFilterActive={tagFilterActive}
							onToggleTagFilter={toggleTagFilter}
							onClearTagFilter={clearTagFilter}
							canCustomizeColumns={Boolean(onColumnsChange)}
							onToggleColumn={toggleColumn}
							onResetColumns={resetColumns}
							onColumnReorder={handleColumnReorder}
							onColumnResize={resizeColumn}
							vaultPath={vaultPath}
							showSelection={selectionActive}
							allSelected={allSelected}
							someSelected={someSelected}
							onToggleAll={handleToggleAll}
						/>
						{/* One shared menu for the whole body: single-row actions, or
						    batch actions when the right-clicked row is selected. */}
						<LibraryRowMenu
							rows={rows}
							vaultPath={vaultPath}
							canEditMeta={canEditMeta}
							selectedKeys={selectedKeys}
							onOpenPaper={openPaperFromRow}
							onRefreshMetadata={handleRefreshPaperMetadata}
							onAddToChat={addPapersToChat}
							onCopyPapers={openCopyDialog}
							onDeletePapers={deletePapers}
							onClearSelection={clearSelection}
							onPrepareContext={prepareContext}
							t={t}
						>
							{/* key={reorderKey} remounts the tbody to replay the fade animation. */}
							<tbody
								key={reorderKey}
								className="animate-in fade-in-0 duration-150"
							>
								{paddingTop > 0 ? (
									<tr aria-hidden className="pointer-events-none">
										<td
											colSpan={
												visibleColumns.length + (selectionActive ? 2 : 1)
											}
											style={{ height: paddingTop }}
										/>
									</tr>
								) : null}
								{virtualRows.map((vr) => {
									const row = rows[vr.index];
									const p = row.paper;
									return (
										<LibraryPaperRow
											key={p.path ?? p.id}
											index={vr.index}
											row={row}
											heat={heatmaps.get(heatmapCacheKey(p))}
											visibleColumns={visibleColumns}
											ctx={cellCtx}
											showSelection={selectionActive}
											selected={selectedKeys.has(paperSelectionKey(p))}
											onToggleSelected={handleToggleSelected}
											onRowClick={handleRowClick}
											onHoverPaper={handleHoverPaper}
											onLeavePaper={previewPaper.cancel}
											measureRef={rowVirtualizer.measureElement}
										/>
									);
								})}
								{paddingBottom > 0 ? (
									<tr aria-hidden className="pointer-events-none">
										<td
											colSpan={
												visibleColumns.length + (selectionActive ? 2 : 1)
											}
											style={{ height: paddingBottom }}
										/>
									</tr>
								) : null}
							</tbody>
						</LibraryRowMenu>
					</table>
					{/* Marquee box: positioned in scroll-content coordinates so it
					    stays glued to the rows while the list auto-scrolls. */}
					<div
						ref={marqueeOverlayRef}
						aria-hidden
						className="pointer-events-none absolute z-20 hidden rounded-[3px] border border-primary/50 bg-primary/10"
					/>
					{!empty ? (
						<p className="sticky left-0 border-border/40 border-t px-3 py-2 text-muted-foreground text-xs tracking-wide">
							{selectedCount > 0
								? t("papersLibrary.selection.countWithTotal", {
										selected: new Intl.NumberFormat(i18n.language).format(
											selectedCount,
										),
										total: new Intl.NumberFormat(i18n.language).format(
											rows.length,
										),
									})
								: t("papersLibrary.count", {
										count: rows.length,
										formatted: new Intl.NumberFormat(i18n.language).format(
											rows.length,
										),
									})}
						</p>
					) : null}
				</div>
				<LibrarySelectionBar
					count={selectedCount}
					onAddToChat={() => addPapersToChat(collectSelectedPapers())}
					onDelete={() => deletePapers(collectSelectedPapers())}
					onClear={clearSelection}
				/>
				<LibraryCopyDialog
					open={copyPapers !== null}
					papers={copyPapers ?? []}
					vaultPath={vaultPath}
					onOpenChange={(next) => {
						if (!next) setCopyPapers(null);
					}}
					onConfirm={confirmCopy}
				/>
				{empty ? (
					<div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
						<p className="font-medium text-sm">
							{filtering
								? t("papersLibrary.noMatch")
								: t("papersLibrary.emptyTitle")}
						</p>
						{filtering ? null : (
							<p className="max-w-sm text-muted-foreground text-xs">
								{t("papersLibrary.emptyHint")}
							</p>
						)}
						{!filtering && onRescan ? (
							<Button
								type="button"
								variant="outline"
								size="sm"
								className="mt-1"
								disabled={rescanning}
								onClick={onRescan}
							>
								<RefreshCw
									className={cn("size-3.5", rescanning && "animate-spin")}
								/>
								{t("papersLibrary.rescan")}
							</Button>
						) : null}
					</div>
				) : null}
			</>
		);
	}

	return (
		<LibraryPdfDropSurface scopePath={scopePath} className={className}>
			{body}
		</LibraryPdfDropSurface>
	);
}
