/**
 * Vault library: table of all papers from catalog.sqlite (display only).
 * Click column headers to sort ascending / descending.
 * Title-header inline search + tags-header filter (no separate toolbar).
 * Single-click a cell to copy that field (deferred so double-click can cancel);
 * double-click a row to open the paper without copying.
 * Reading heat: title text background as a left→right spine (doc start→end).
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import { RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCellCopy } from "@/components/library/hooks/use-cell-copy";
import { useLibraryHeatmap } from "@/components/library/hooks/use-library-heatmap";
import { COLUMN_META } from "@/components/library/library-columns";
import { LibraryPaperRow } from "@/components/library/library-paper-row";
import { LibraryPdfDropSurface } from "@/components/library/library-pdf-drop-surface";
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
import { LibraryTableHeader } from "@/components/library/library-table-header";
import { Button } from "@/components/ui/button";
import { useDebouncedCallback } from "@/hooks/use-debounce";
import { cn } from "@/lib/core/utils";
import type { PaperMetadata } from "@/lib/paper";
import { filterPapersByScope } from "@/lib/paper/api";
import { refreshLibraryPublications } from "@/lib/paper/library-actions";
import { heatmapCacheKey } from "@/lib/paper/reading-heatmap";
import { type PaperTag, visiblePaperTags } from "@/lib/paper/tags";
import {
	DEFAULT_LIBRARY_COLUMNS,
	type LibraryColumnPref,
	useUiScale,
} from "@/lib/settings";
import { joinVaultPath } from "@/lib/vault";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";

export type PapersLibraryProps = {
	/** Full catalog list (or pre-scoped); further filtered by `scopePath`. */
	papers: PaperMetadata[];
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
			// Year defaults to newest first; text columns ascending
			setSortDir(key === "year" ? "desc" : "asc");
		},
		[sortKey],
	);

	const { onCellCopy, openPaperFromRow } = useCellCopy({ t, onOpenPaper });

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
	const visibleColumnWeight = useMemo(
		() =>
			visibleColumns.reduce(
				(total, col) => total + COLUMN_META[col.key].widthWeight,
				0,
			),
		[visibleColumns],
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

	const canRefreshPublications =
		Boolean(vaultPath) && !isRemoteVaultHandle(vaultPath);
	const handleRefreshPublications = useCallback(() => {
		void refreshLibraryPublications(vaultPath, scopedPapers);
	}, [vaultPath, scopedPapers]);

	const normalizedQuery = (inputValue ?? "").trim().toLocaleLowerCase();
	const tagFilterSet = useMemo(() => new Set(tagFilter), [tagFilter]);

	/** Unique tags in the current folder scope (for the tags-column filter menu). */
	const availableTags = useMemo(() => {
		const byName = new Map<string, PaperTag>();
		for (const p of scopedPapers) {
			for (const tag of visiblePaperTags(p.tags)) {
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

	/** Coerce tags + sort keys once per paper list change (not per keystroke). */
	const indexedRows = useMemo(
		() => scopedPapers.map(buildPaperRow),
		[scopedPapers],
	);

	/** Keystroke-level work is filter + sort over precomputed rows only. */
	const rows = useMemo(() => {
		let filtered = indexedRows;
		if (normalizedQuery) {
			filtered = filtered.filter(
				(row) =>
					String(row.sort.title).includes(normalizedQuery) ||
					row.tagSearch.includes(normalizedQuery),
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

	// Reorder cue: replay a quick fade when the user re-sorts or changes tag
	// filters. Deliberately excludes the search query — per-keystroke remounts
	// would flicker (high-frequency input, motion-15).
	const reorderKey = useMemo(
		() => `${sortKey}:${sortDir}:${tagFilter.join(",")}`,
		[sortKey, sortDir, tagFilter],
	);

	const scrollRef = useRef<HTMLDivElement>(null);
	const uiScale = useUiScale();
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
		body = (
			<div
				ref={scrollRef}
				className="agentero-scroll-both min-h-0 min-w-0 flex-1"
			>
				{/* Fixed weights keep the table stable while content and rows change. */}
				<table className="w-full min-w-[900px] table-fixed border-collapse text-left text-sm">
					<colgroup>
						{visibleColumns.map((col) => (
							<col
								key={col.key}
								style={{
									width: `${(COLUMN_META[col.key].widthWeight / visibleColumnWeight) * 100}%`,
								}}
							/>
						))}
					</colgroup>
					<LibraryTableHeader
						t={t}
						columns={columns}
						visibleColumns={visibleColumns}
						sortKey={sortKey}
						sortDir={sortDir}
						onSort={handleSort}
						searchEnabled={Boolean(onQueryChange)}
						inputValue={inputValue}
						onInputChange={onSearchInputChange}
						canRefreshPublications={canRefreshPublications}
						onRefreshPublications={handleRefreshPublications}
						availableTags={availableTags}
						tagFilterSet={tagFilterSet}
						tagFilterActive={tagFilterActive}
						onToggleTagFilter={toggleTagFilter}
						onClearTagFilter={() => setTagFilter([])}
						canCustomizeColumns={Boolean(onColumnsChange)}
						onToggleColumn={toggleColumn}
						onResetColumns={resetColumns}
						onColumnReorder={handleColumnReorder}
					/>
					{/* key={reorderKey} remounts the tbody to replay the fade animation. */}
					<tbody key={reorderKey} className="animate-in fade-in-0 duration-150">
						{!rows.length ? (
							<tr>
								<td colSpan={visibleColumns.length} className="p-0">
									<div className="flex min-h-[200px] flex-col items-center justify-center gap-2 p-8 text-center">
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
													className={cn(
														"size-3.5",
														rescanning && "animate-spin",
													)}
												/>
												{t("papersLibrary.rescan")}
											</Button>
										) : null}
									</div>
								</td>
							</tr>
						) : (
							<>
								{paddingTop > 0 ? (
									<tr aria-hidden>
										<td
											colSpan={visibleColumns.length}
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
											paperAbsPath={
												p.path && vaultPath
													? joinVaultPath(vaultPath, p.path)
													: null
											}
											canEditMeta={canEditMeta}
											onOpenPaper={openPaperFromRow}
											measureRef={rowVirtualizer.measureElement}
										/>
									);
								})}
								{paddingBottom > 0 ? (
									<tr aria-hidden>
										<td
											colSpan={visibleColumns.length}
											style={{ height: paddingBottom }}
										/>
									</tr>
								) : null}
							</>
						)}
					</tbody>
				</table>
				{rows.length > 0 ? (
					<p className="sticky left-0 px-3 py-2 text-muted-foreground text-xs">
						{t("papersLibrary.count", {
							count: rows.length,
							formatted: new Intl.NumberFormat(i18n.language).format(
								rows.length,
							),
						})}
					</p>
				) : null}
			</div>
		);
	}

	return (
		<LibraryPdfDropSurface scopePath={scopePath} className={className}>
			{body}
		</LibraryPdfDropSurface>
	);
}
