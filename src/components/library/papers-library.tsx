/**
 * Vault library: table of all papers from catalog.sqlite (display only).
 * Click column headers to sort ascending / descending.
 * Title-header inline search + tags-header filter (no separate toolbar).
 * Single-click a cell to copy that field (deferred so double-click can cancel);
 * double-click a row to open the paper without copying.
 * Reading heat: title text background as a left→right spine (doc start→end).
 */
import { useVirtualizer } from "@tanstack/react-virtual";
import {
	ArrowDown,
	ArrowUp,
	ArrowUpDown,
	ListFilter,
	RefreshCw,
	Search,
	X,
} from "lucide-react";
import {
	Fragment,
	type MouseEvent as ReactMouseEvent,
	type ReactNode,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { LibraryPdfDropSurface } from "@/components/library/library-pdf-drop-surface";
import { PaperTagChip } from "@/components/library/paper-tag-chip";
import { ReadingTitleHeat } from "@/components/library/reading-heatmap";
import { Button } from "@/components/ui/button";
import {
	ContextMenu,
	ContextMenuCheckboxItem,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { cn } from "@/lib/core/utils";
import { formatAuthorsShort, type PaperMetadata } from "@/lib/paper";
import {
	filterPapersByScope,
	listPaperPageCounts,
	savePaperPageCounts,
} from "@/lib/paper/api";
import {
	heatmapCacheKey,
	loadReadingHeatmaps,
	type ReadingHeatmap,
} from "@/lib/paper/reading-heatmap";
import {
	DEFAULT_LIBRARY_COLUMNS,
	type LibraryColumnKey,
	type LibraryColumnPref,
	useUiScale,
} from "@/lib/settings";
import { type PaperTag, visiblePaperTags } from "@/lib/ui/tag-colors";

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
 * Delay before committing a cell-copy click.
 * Must outlast a typical double-click interval so the first half of a
 * double-click does not copy before `detail > 1` / `dblclick` can cancel it.
 */
const CELL_COPY_CLICK_DELAY_MS = 320;

/**
 * Delay before a keystroke commits to the shared library query.
 * Keeps typing local to the input so each key does not re-filter/sort the
 * full catalog (and re-render workspace subscribers of `query`).
 */
const SEARCH_DEBOUNCE_MS = 250;

type SortKey = LibraryColumnKey;
type SortDir = "asc" | "desc";

/** Full author list for clipboard (not the abbreviated display form). */
function authorsCopyText(authors: string[] | undefined): string | null {
	if (!authors?.length) return null;
	return authors.join(", ");
}

/** Identifier for display / copy / sort — null when nothing usable. */
function identifierValue(p: PaperMetadata): string | null {
	if (p.arxiv_id) return p.arxiv_id;
	if (p.doi) return p.doi;
	if (p.pmid) return `PMID:${p.pmid}`;
	return p.id || null;
}

/** Precomputed per-paper keys so sort/filter avoid O(n log n) re-coerce. */
type PaperRow = {
	paper: PaperMetadata;
	tags: PaperTag[];
	tagSearch: string;
	sort: Record<SortKey, string | number>;
};

function buildPaperRow(p: PaperMetadata): PaperRow {
	const tags = visiblePaperTags(p.tags);
	const id = identifierValue(p) ?? "";
	return {
		paper: p,
		tags,
		tagSearch: tags
			.map((t) => t.name)
			.join(" ")
			.toLocaleLowerCase(),
		sort: {
			title: (p.title ?? "").toLocaleLowerCase(),
			authors: (p.authors?.[0] ?? "").toLocaleLowerCase(),
			year: p.year ?? Number.NEGATIVE_INFINITY,
			type: (p.type ?? "").toLocaleLowerCase(),
			id: id.toLocaleLowerCase(),
			tags: tags
				.map((t) => t.name)
				.join(", ")
				.toLocaleLowerCase(),
		},
	};
}

function comparePaperRows(
	a: PaperRow,
	b: PaperRow,
	key: SortKey,
	dir: SortDir,
): number {
	const av = a.sort[key];
	const bv = b.sort[key];
	let cmp = 0;
	if (typeof av === "number" && typeof bv === "number") {
		cmp = av - bv;
	} else {
		cmp = String(av).localeCompare(String(bv), undefined, {
			numeric: true,
			sensitivity: "base",
		});
	}
	if (cmp === 0) {
		// Stable secondary: title then id
		cmp = (a.paper.title ?? "").localeCompare(b.paper.title ?? "", undefined, {
			sensitivity: "base",
		});
		if (cmp === 0) cmp = (a.paper.id ?? "").localeCompare(b.paper.id ?? "");
	}
	return dir === "asc" ? cmp : -cmp;
}

/** Move `fromKey` to sit just before `toKey` in the full column list. */
function reorderColumns(
	cols: LibraryColumnPref[],
	fromKey: SortKey,
	toKey: SortKey,
): LibraryColumnPref[] {
	if (fromKey === toKey) return cols;
	const arr = [...cols];
	const fromIdx = arr.findIndex((c) => c.key === fromKey);
	if (fromIdx < 0) return cols;
	const [moved] = arr.splice(fromIdx, 1);
	const toIdx = arr.findIndex((c) => c.key === toKey);
	if (toIdx < 0) return cols;
	arr.splice(toIdx, 0, moved);
	return arr;
}

/** Toggle a column's visibility (title is kept visible by the caller). */
function toggleColumnVisibility(
	cols: LibraryColumnPref[],
	key: SortKey,
): LibraryColumnPref[] {
	return cols.map((c) => (c.key === key ? { ...c, visible: !c.visible } : c));
}

/** Narrow i18n helper for column renderers (avoids strict TFunction key unions). */
type CellT = (key: string, options?: Record<string, unknown>) => string;

type CellCtx = {
	t: CellT;
	onCellCopy: (
		e: ReactMouseEvent,
		text: string | null | undefined,
		label: string,
	) => void;
	heat: ReadingHeatmap | undefined;
	tags: PaperTag[];
};

type ColumnDef = {
	labelKey: string;
	widthWeight: number;
	headerClassName: string;
	render: (p: PaperMetadata, ctx: CellCtx) => ReactNode;
};

const COPY_CELL_BASE =
	"cursor-pointer rounded-sm hover:bg-muted/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Single-click-to-copy cell control shared by library columns. */
function CopyCellButton({
	copyText,
	labelKey,
	ctx,
	className,
	children,
}: {
	copyText: string | null | undefined;
	labelKey: string;
	ctx: Pick<CellCtx, "t" | "onCellCopy">;
	className?: string;
	children: ReactNode;
}) {
	const label = ctx.t(labelKey);
	const copyHint = ctx.t("papersLibrary.copyHint", { label });
	const canCopy = Boolean(copyText?.trim());
	return (
		<button
			type="button"
			className={cn(COPY_CELL_BASE, className)}
			title={canCopy ? copyHint : undefined}
			aria-label={copyHint}
			onClick={(e) => ctx.onCellCopy(e, copyText, label)}
		>
			{children}
		</button>
	);
}

/** `<td>` + copy button for plain columns (year / type / id …). */
function CopyTd({
	tdClassName,
	copyText,
	labelKey,
	ctx,
	buttonClassName,
	children,
}: {
	tdClassName: string;
	copyText: string | null | undefined;
	labelKey: string;
	ctx: Pick<CellCtx, "t" | "onCellCopy">;
	buttonClassName?: string;
	children: ReactNode;
}) {
	return (
		<td className={tdClassName}>
			<CopyCellButton
				copyText={copyText}
				labelKey={labelKey}
				ctx={ctx}
				className={buttonClassName}
			>
				{children}
			</CopyCellButton>
		</td>
	);
}

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
	if (!active) {
		return <ArrowUpDown className="size-3 shrink-0 opacity-40" aria-hidden />;
	}
	return dir === "asc" ? (
		<ArrowUp className="size-3 shrink-0 text-foreground" aria-hidden />
	) : (
		<ArrowDown className="size-3 shrink-0 text-foreground" aria-hidden />
	);
}

/** Column layout + cell renderers (data-driven; no switch in the component). */
const COLUMN_META = {
	title: {
		labelKey: "papersLibrary.colTitle",
		widthWeight: 32,
		headerClassName: "min-w-[240px]",
		render: (p, ctx) => (
			<td className="min-w-0 max-w-0 overflow-hidden px-3 py-2.5">
				<CopyCellButton
					copyText={p.title}
					labelKey="papersLibrary.colTitle"
					ctx={ctx}
					className="block w-full text-left font-medium"
				>
					<ReadingTitleHeat heatmap={ctx.heat} className="line-clamp-1">
						<span className="block truncate" title={p.title}>
							{p.title}
						</span>
					</ReadingTitleHeat>
				</CopyCellButton>
				{p.publication ? (
					<CopyCellButton
						copyText={p.publication}
						labelKey="papersLibrary.colPublication"
						ctx={ctx}
						className="mt-0.5 block w-full text-left text-muted-foreground text-xs"
					>
						<span className="line-clamp-1" title={p.publication}>
							{p.publication}
						</span>
					</CopyCellButton>
				) : null}
			</td>
		),
	},
	authors: {
		labelKey: "papersLibrary.colAuthors",
		widthWeight: 18,
		headerClassName: "min-w-[140px]",
		render: (p, ctx) => (
			<td className="min-w-0 max-w-0 overflow-hidden px-3 py-2.5 text-muted-foreground text-xs">
				<Tooltip>
					<TooltipTrigger asChild>
						<CopyCellButton
							copyText={authorsCopyText(p.authors)}
							labelKey="papersLibrary.colAuthors"
							ctx={ctx}
							className="block w-full text-left"
						>
							<span>{formatAuthorsShort(p.authors) || "—"}</span>
						</CopyCellButton>
					</TooltipTrigger>
					{p.authors && p.authors.length > 2 ? (
						<TooltipContent side="top" align="start" className="max-w-xs">
							{p.authors.join(", ")}
						</TooltipContent>
					) : null}
				</Tooltip>
			</td>
		),
	},
	year: {
		labelKey: "papersLibrary.colYear",
		widthWeight: 8,
		headerClassName: "min-w-16",
		render: (p, ctx) => (
			<CopyTd
				tdClassName="whitespace-nowrap px-3 py-2.5 tabular-nums text-muted-foreground text-xs"
				copyText={p.year != null ? String(p.year) : null}
				labelKey="papersLibrary.colYear"
				ctx={ctx}
				buttonClassName="px-0.5"
			>
				{p.year ?? "—"}
			</CopyTd>
		),
	},
	tags: {
		labelKey: "papersLibrary.colTags",
		widthWeight: 18,
		headerClassName: "min-w-[120px]",
		render: (_p, { t, onCellCopy, tags }) => {
			const label = t("papersLibrary.colTags");
			const hint = t("papersLibrary.copyHint", { label });
			return (
				<td className="min-w-0 max-w-0 overflow-hidden px-3 py-2.5">
					{tags.length ? (
						<div className="flex flex-wrap gap-1">
							{tags.map((tag) => (
								<PaperTagChip
									key={tag.name}
									tag={tag}
									title={hint}
									aria-label={t("papersLibrary.copyHint", {
										label: tag.name,
									})}
									onClick={(e) => onCellCopy(e, tag.name, label)}
								/>
							))}
						</div>
					) : (
						<span className="text-muted-foreground text-xs">—</span>
					)}
				</td>
			);
		},
	},
	type: {
		labelKey: "papersLibrary.colType",
		widthWeight: 10,
		headerClassName: "min-w-24",
		render: (p, ctx) => (
			<CopyTd
				tdClassName="whitespace-nowrap px-3 py-2.5 text-muted-foreground text-xs capitalize"
				copyText={p.type || null}
				labelKey="papersLibrary.colType"
				ctx={ctx}
				buttonClassName="px-0.5"
			>
				{p.type || "—"}
			</CopyTd>
		),
	},
	id: {
		labelKey: "papersLibrary.colId",
		widthWeight: 14,
		headerClassName: "min-w-[160px]",
		render: (p, ctx) => {
			const value = identifierValue(p);
			return (
				<CopyTd
					tdClassName="min-w-0 max-w-0 overflow-hidden px-3 py-2.5 font-mono text-muted-foreground text-xs"
					copyText={value}
					labelKey="papersLibrary.colId"
					ctx={ctx}
					buttonClassName="block w-full text-left"
				>
					<span className="line-clamp-1" title={value ?? undefined}>
						{value ?? "—"}
					</span>
				</CopyTd>
			);
		},
	},
} as const satisfies Record<SortKey, ColumnDef>;

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
	const [tagFilterOpen, setTagFilterOpen] = useState(false);
	const [heatmaps, setHeatmaps] = useState<Map<string, ReadingHeatmap>>(
		() => new Map(),
	);
	/** Pending cell-copy timer — cleared when a double-click opens the paper. */
	const pendingCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
		null,
	);

	/**
	 * Local mirror of `query`: keystrokes filter the (precomputed) rows here
	 * immediately, but only commit to the shared query after a debounce so
	 * workspace subscribers are not re-rendered on every key.
	 */
	const [inputValue, setInputValue] = useState(query);
	const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		setInputValue(query);
		if (searchDebounceRef.current) {
			clearTimeout(searchDebounceRef.current);
			searchDebounceRef.current = null;
		}
	}, [query]);

	useEffect(
		() => () => {
			if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
		},
		[],
	);

	const onSearchInputChange = useCallback(
		(value: string) => {
			setInputValue(value);
			if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
			searchDebounceRef.current = setTimeout(() => {
				searchDebounceRef.current = null;
				onQueryChange?.(value);
			}, SEARCH_DEBOUNCE_MS);
		},
		[onQueryChange],
	);

	const cancelPendingCopy = useCallback(() => {
		if (pendingCopyTimerRef.current != null) {
			clearTimeout(pendingCopyTimerRef.current);
			pendingCopyTimerRef.current = null;
		}
	}, []);

	useEffect(() => () => cancelPendingCopy(), [cancelPendingCopy]);

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

	/** Single-click a cell → copy that field; skip empty values. */
	const copyField = useCallback(
		async (text: string | null | undefined, label: string) => {
			const value = text?.trim();
			if (!value) return;
			await copyTextToClipboard(value, {
				successMessage: t("papersLibrary.copied", { label }),
				errorMessage: t("papersLibrary.copyFailed"),
				successNotify: {
					duration: 1500,
					id: "papers-library-copied",
				},
			});
		},
		[t],
	);

	/**
	 * Cell click → schedule copy. Double-click fires a second click with
	 * `detail > 1` plus `dblclick` on the row; both cancel the pending copy
	 * so opening a paper does not also write the clipboard.
	 */
	const onCellCopy = useCallback(
		(e: ReactMouseEvent, text: string | null | undefined, label: string) => {
			// Second (or later) click of a multi-click: abort any scheduled copy.
			if (e.detail > 1) {
				cancelPendingCopy();
				return;
			}
			cancelPendingCopy();
			pendingCopyTimerRef.current = setTimeout(() => {
				pendingCopyTimerRef.current = null;
				void copyField(text, label);
			}, CELL_COPY_CLICK_DELAY_MS);
		},
		[cancelPendingCopy, copyField],
	);

	const openPaperFromRow = useCallback(
		(paper: PaperMetadata) => {
			cancelPendingCopy();
			onOpenPaper(paper);
		},
		[cancelPendingCopy, onOpenPaper],
	);

	// --- Column customization (order + visibility) ---
	const [dragKey, setDragKey] = useState<SortKey | null>(null);
	const [dragOverKey, setDragOverKey] = useState<SortKey | null>(null);

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

	const handleColumnDrop = useCallback(
		(toKey: SortKey) => {
			const from = dragKey;
			setDragKey(null);
			setDragOverKey(null);
			if (!onColumnsChange || !from) return;
			onColumnsChange(reorderColumns(columns, from, toKey));
		},
		[columns, dragKey, onColumnsChange],
	);

	/** Folder scope first (cheap path-prefix filter on in-memory catalog). */
	const scopedPapers = useMemo(
		() => filterPapersByScope(papers, scopePath),
		[papers, scopePath],
	);

	/**
	 * Heatmap cache survives re-renders and background catalog refreshes
	 * (which replace `scopedPapers` identity without changing content).
	 * Only refocusing the Library tab clears it to pick up fresh PDF activity.
	 */
	const heatmapCacheRef = useRef<{
		vault: string | null;
		map: Map<string, ReadingHeatmap>;
	}>({ vault: null, map: new Map() });
	const wasActiveRef = useRef(false);

	/** Load reading heatmaps for the current folder scope (full library or org folder). */
	useEffect(() => {
		const justActivated = active && !wasActiveRef.current;
		wasActiveRef.current = active;
		if (!active) return;
		if (!vaultPath || !scopedPapers.length) {
			setHeatmaps(new Map());
			return;
		}
		const cache = heatmapCacheRef.current;
		if (cache.vault !== vaultPath) {
			cache.vault = vaultPath;
			cache.map = new Map();
		}
		if (justActivated) cache.map.clear();

		const cachedNow = new Map<string, ReadingHeatmap>();
		const missing: PaperMetadata[] = [];
		for (const p of scopedPapers) {
			const key = heatmapCacheKey(p);
			const hit = cache.map.get(key);
			if (hit) cachedNow.set(key, hit);
			else missing.push(p);
		}
		if (cachedNow.size > 0) setHeatmaps(cachedNow);
		if (!missing.length) return;

		let cancelled = false;
		void (async () => {
			// Persisted page counts skip the per-paper full-PDF read.
			const pageCounts = await listPaperPageCounts(vaultPath);
			const { heatmaps, discoveredPageCounts } = await loadReadingHeatmaps(
				vaultPath,
				missing,
				{ concurrency: 6, pageCounts },
			);
			if (cancelled) return;
			if (discoveredPageCounts.size > 0) {
				void savePaperPageCounts(vaultPath, discoveredPageCounts);
			}
			for (const [key, heat] of heatmaps) cache.map.set(key, heat);
			setHeatmaps((prev) => {
				const next = new Map(prev);
				for (const [key, heat] of heatmaps) next.set(key, heat);
				return next;
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [vaultPath, scopedPapers, active]);

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

	const filtering = normalizedQuery.length > 0 || tagFilterSet.size > 0;
	const tagFilterActive = tagFilterSet.size > 0;

	const tableHeader = (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<thead className="sticky top-0 z-[1] border-b bg-background/95 backdrop-blur-sm">
					<tr className="text-muted-foreground text-xs">
						{visibleColumns.map((col) => {
							const meta = COLUMN_META[col.key];
							const active = sortKey === col.key;
							const isDragOver = dragOverKey === col.key && dragKey !== col.key;
							const isTitle = col.key === "title";
							const isTags = col.key === "tags";
							return (
								<th
									key={col.key}
									className={cn(
										meta.headerClassName,
										"p-0 font-medium",
										dragKey === col.key && "opacity-50",
										isDragOver && "bg-muted",
									)}
									aria-sort={
										active
											? sortDir === "asc"
												? "ascending"
												: "descending"
											: "none"
									}
									draggable={Boolean(onColumnsChange)}
									onDragStart={(e) => {
										const target = e.target as HTMLElement;
										if (
											target.closest("input,button[data-library-header-action]")
										) {
											e.preventDefault();
											return;
										}
										setDragKey(col.key);
										e.dataTransfer.effectAllowed = "move";
										e.dataTransfer.setData("text/plain", col.key);
									}}
									onDragOver={(e) => {
										if (!dragKey) return;
										e.preventDefault();
										e.dataTransfer.dropEffect = "move";
										if (dragOverKey !== col.key) setDragOverKey(col.key);
									}}
									onDrop={(e) => {
										e.preventDefault();
										handleColumnDrop(col.key);
									}}
									onDragEnd={() => {
										setDragKey(null);
										setDragOverKey(null);
									}}
								>
									<div className="flex min-w-0 items-center gap-1 px-3 py-1.5">
										<button
											type="button"
											className={cn(
												"flex min-w-0 shrink items-center gap-1 py-0.5 text-left cursor-grab active:cursor-grabbing",
												"hover:text-foreground",
												"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
												active && "text-foreground",
											)}
											onClick={() => handleSort(col.key)}
											aria-label={t("papersLibrary.sortBy", {
												column: t(meta.labelKey),
											})}
										>
											<span className="truncate">{t(meta.labelKey)}</span>
											<SortIcon active={active} dir={sortDir} />
										</button>
										{isTitle && onQueryChange ? (
											<div className="relative ml-1 min-w-0 flex-1">
												<Search
													className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-muted-foreground"
													aria-hidden
												/>
												<Input
													type="search"
													value={inputValue}
													onChange={(e) => onSearchInputChange(e.target.value)}
													aria-label={t("papersLibrary.search")}
													className="h-6 border-transparent bg-muted/50 pl-6 pr-1.5 text-xs shadow-none focus-visible:border-input focus-visible:bg-background"
													onMouseDown={(e) => e.stopPropagation()}
													onClick={(e) => e.stopPropagation()}
													onKeyDown={(e) => e.stopPropagation()}
												/>
											</div>
										) : null}
										{isTags ? (
											<Popover
												open={tagFilterOpen}
												onOpenChange={setTagFilterOpen}
											>
												<Tooltip>
													<TooltipTrigger asChild>
														<PopoverTrigger asChild>
															<button
																type="button"
																data-library-header-action
																className={cn(
																	"ml-auto flex size-6 shrink-0 items-center justify-center rounded-sm",
																	"hover:bg-muted/60 hover:text-foreground",
																	"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
																	tagFilterActive &&
																		"bg-muted/60 text-foreground",
																)}
																aria-label={t("papersLibrary.filterTags")}
																aria-pressed={tagFilterActive}
																onClick={(e) => e.stopPropagation()}
																onMouseDown={(e) => e.stopPropagation()}
															>
																<ListFilter className="size-3.5" aria-hidden />
															</button>
														</PopoverTrigger>
													</TooltipTrigger>
													<TooltipContent side="bottom">
														{t("papersLibrary.filterTags")}
													</TooltipContent>
												</Tooltip>
												<PopoverContent
													align="start"
													className="w-56 p-2"
													onOpenAutoFocus={(e) => e.preventDefault()}
												>
													{availableTags.length === 0 ? (
														<p className="px-1 py-2 text-muted-foreground text-xs">
															{t("papersLibrary.filterTagsEmpty")}
														</p>
													) : (
														<div className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
															{availableTags.map((tag) => {
																const selected = tagFilterSet.has(tag.name);
																return (
																	<button
																		key={tag.name}
																		type="button"
																		className={cn(
																			"flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-xs",
																			"hover:bg-muted/60",
																			selected && "bg-muted/50",
																		)}
																		aria-pressed={selected}
																		onClick={() => toggleTagFilter(tag.name)}
																	>
																		<span
																			className={cn(
																				"flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
																				selected
																					? "border-primary bg-primary text-primary-foreground"
																					: "border-muted-foreground/40",
																			)}
																			aria-hidden
																		>
																			{selected ? (
																				<span className="text-[9px] leading-none">
																					✓
																				</span>
																			) : null}
																		</span>
																		<PaperTagChip tag={tag} />
																	</button>
																);
															})}
														</div>
													)}
													{tagFilterActive ? (
														<>
															<div className="my-1.5 h-px bg-border" />
															<button
																type="button"
																className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground text-xs hover:bg-muted/60 hover:text-foreground"
																onClick={() => setTagFilter([])}
															>
																<X className="size-3" aria-hidden />
																{t("papersLibrary.clearTagFilter")}
															</button>
														</>
													) : null}
												</PopoverContent>
											</Popover>
										) : null}
									</div>
								</th>
							);
						})}
					</tr>
				</thead>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-44">
				<ContextMenuLabel>
					{t("papersLibrary.columnsMenuLabel")}
				</ContextMenuLabel>
				{columns.map((col) => (
					<ContextMenuCheckboxItem
						key={col.key}
						checked={col.visible}
						disabled={col.key === "title" || !onColumnsChange}
						onSelect={(e) => e.preventDefault()}
						onCheckedChange={() => toggleColumn(col.key)}
					>
						{t(COLUMN_META[col.key].labelKey)}
					</ContextMenuCheckboxItem>
				))}
				<ContextMenuSeparator />
				<ContextMenuItem
					disabled={!onColumnsChange}
					onSelect={() => resetColumns()}
				>
					{t("papersLibrary.resetColumns")}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);

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
					{tableHeader}
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
									const heat = heatmaps.get(heatmapCacheKey(p));
									const cellCtx: CellCtx = {
										t,
										onCellCopy,
										heat,
										tags: row.tags,
									};
									return (
										<tr
											key={p.path ?? p.id}
											data-index={vr.index}
											ref={rowVirtualizer.measureElement}
											className="border-b border-border/60 transition-colors hover:bg-muted/50"
											onDoubleClick={() => openPaperFromRow(p)}
										>
											{visibleColumns.map((col) => (
												<Fragment key={col.key}>
													{COLUMN_META[col.key].render(p, cellCtx)}
												</Fragment>
											))}
										</tr>
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
