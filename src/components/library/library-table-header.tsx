/**
 * Sticky header row for the papers library table.
 *
 * Per-column sort button, title-header inline search, metadata refresh,
 * and the tags-filter popover; right-click customizes column order +
 * visibility. When `compact` (table is actively scrolling), search +
 * action icons hide so only column labels remain; row height stays
 * fixed (`h-9`). Transient drag state (dragKey/dragOverKey) lives here —
 * the parent only receives committed reorder events. Memoized so
 * scrolling the virtualized body does not re-render the header unless
 * compact/props change.
 */
import { Award, ListFilter, RefreshCw, Search, X } from "lucide-react";
import { memo, useEffect, useState } from "react";
import { LibraryColumnResizeHandle } from "@/components/library/library-column-resize-handle";
import { COLUMN_META, SortIcon } from "@/components/library/library-columns";
import type {
	CellT,
	SortDir,
	SortKey,
} from "@/components/library/library-row-utils";
import { PaperTagChip } from "@/components/library/paper-tag-chip";
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
import { errorMessage, notifyError, notifySuccess } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import {
	buildEasyScholarTags,
	fetchEasyScholarRank,
	mergeEasyScholarTags,
} from "@/lib/easyscholar";
import type { PaperMetadata } from "@/lib/paper";
import { libraryStore, setLibraryPaperTags } from "@/lib/paper/library-store";
import type { PaperTag } from "@/lib/paper/tags";
import type { LibraryColumnPref } from "@/lib/settings";
import { getVaultPath } from "@/lib/vault/store";

type LibraryTableHeaderProps = {
	t: CellT;
	/** Full column list (order + visibility) for the customization menu. */
	columns: LibraryColumnPref[];
	/** Ordered, visible columns actually rendered as `<th>`. */
	visibleColumns: LibraryColumnPref[];
	sortKey: SortKey;
	sortDir: SortDir;
	onSort: (key: SortKey) => void;
	/**
	 * Actively scrolling: hide search input and header action icons,
	 * keep column label text (and active sort chevron). Idle restores.
	 */
	compact?: boolean;
	/** Inline title search; hidden when the shared query is not controlled. */
	searchEnabled: boolean;
	inputValue: string;
	onInputChange: (value: string) => void;
	/** Metadata refresh (local vault only). */
	canRefreshMetadata: boolean;
	onRefreshMetadata: () => void;
	/** Tags-column filter popover. */
	availableTags: PaperTag[];
	tagFilterSet: Set<string>;
	tagFilterActive: boolean;
	onToggleTagFilter: (name: string) => void;
	onClearTagFilter: () => void;
	/** Column customization (drag reorder + show/hide menu). */
	canCustomizeColumns: boolean;
	onToggleColumn: (key: SortKey) => void;
	onResetColumns: () => void;
	onColumnReorder: (fromKey: SortKey, toKey: SortKey) => void;
	onColumnResize: (key: SortKey, width: number | null, commit: boolean) => void;
	/** Vault path for EasyScholar batch tag fetch. */
	vaultPath?: string | null;
	/** Papers currently visible in the library scope. */
	papers: PaperMetadata[];
};

export const LibraryTableHeader = memo(function LibraryTableHeader({
	t,
	columns,
	visibleColumns,
	sortKey,
	sortDir,
	onSort,
	compact = false,
	searchEnabled,
	inputValue,
	onInputChange,
	canRefreshMetadata,
	onRefreshMetadata,
	availableTags,
	tagFilterSet,
	tagFilterActive,
	onToggleTagFilter,
	onClearTagFilter,
	canCustomizeColumns,
	onToggleColumn,
	onResetColumns,
	onColumnReorder,
	onColumnResize,
	vaultPath,
	papers,
}: LibraryTableHeaderProps) {
	// --- Column customization (order + visibility) ---
	const [dragKey, setDragKey] = useState<SortKey | null>(null);
	const [dragOverKey, setDragOverKey] = useState<SortKey | null>(null);
	const [tagFilterOpen, setTagFilterOpen] = useState(false);
	const [rankBusy, setRankBusy] = useState(false);

	useEffect(() => {
		if (compact) setTagFilterOpen(false);
	}, [compact]);

	const showActions = !compact;
	/** Fade chrome in place (keeps h-9); hide instantly, restore with fade-in. */
	const chromeFadeClass = showActions
		? "opacity-100 duration-300"
		: "pointer-events-none opacity-0 duration-0";
	const canFetchRanks = Boolean(vaultPath) && !rankBusy && papers.length > 0;

	const fetchAllRanks = async () => {
		if (!vaultPath || rankBusy) return;
		setRankBusy(true);
		let updated = 0;
		let failed = 0;
		let empty = 0;
		try {
			for (const paper of papers) {
				const title = paper.publication?.trim();
				if (!title || !paper.path) continue;
				try {
					const response = await fetchEasyScholarRank(title);
					const data = response.data?.officialRank?.all;
					if (!data || Object.keys(data).length === 0) {
						empty += 1;
						continue;
					}
					const newTags = buildEasyScholarTags(title, data);
					// The request may take seconds: merge with edits made while it was in flight.
					if (getVaultPath() !== vaultPath) break;
					const current = libraryStore
						.getState()
						.papers.find((row) => row.path === paper.path);
					if (!current) continue;
					await setLibraryPaperTags(
						vaultPath,
						paper.path,
						mergeEasyScholarTags(current.tags, newTags),
					);
					updated += 1;
				} catch {
					failed += 1;
					// Continue with the next paper; summarize at the end.
				}
			}
			notifySuccess(
				t("papersLibrary.easyScholar.batchDone", { updated, failed, empty }),
			);
		} catch (err) {
			notifyError(t("papersLibrary.easyScholar.fetchFailed"), {
				description: errorMessage(err),
			});
		} finally {
			setRankBusy(false);
		}
	};

	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<thead
					data-library-header
					className="sticky top-0 z-[1] select-none border-b border-transparent bg-background/72 shadow-[0_1px_0_0_color-mix(in_oklch,var(--border)_55%,transparent)] backdrop-blur-xl backdrop-saturate-150 supports-backdrop-blur:bg-background/60"
				>
					<tr className="text-muted-foreground text-xs tracking-wide">
						{visibleColumns.map((col) => {
							const meta = COLUMN_META[col.key];
							const active = sortKey === col.key;
							const isDragOver = dragOverKey === col.key && dragKey !== col.key;
							const isTitle = col.key === "title";
							const isTags = col.key === "tags";
							const isPublication = col.key === "publication";
							return (
								<th
									key={col.key}
									className={cn(
										meta.headerClassName,
										"relative p-0 font-medium",
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
									draggable={canCustomizeColumns}
									onDragStart={(e) => {
										const target = e.target as HTMLElement;
										if (
											target.closest(
												"input,button[data-library-header-action],[data-library-resize]",
											)
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
										const from = dragKey;
										setDragKey(null);
										setDragOverKey(null);
										if (!from || from === col.key) return;
										onColumnReorder(from, col.key);
									}}
									onDragEnd={() => {
										setDragKey(null);
										setDragOverKey(null);
									}}
								>
									{/* Fixed h-9 so compact fade never changes header height. */}
									<div className="flex h-9 min-w-0 items-center gap-1 px-3">
										<button
											type="button"
											className={cn(
												"flex min-w-0 shrink items-center gap-1 py-0.5 text-left cursor-grab active:cursor-grabbing",
												"hover:text-foreground",
												"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
												active && "text-foreground",
											)}
											onClick={() => onSort(col.key)}
											aria-label={t("papersLibrary.sortBy", {
												column: t(meta.labelKey),
											})}
										>
											<span className="truncate">{t(meta.labelKey)}</span>
											<span
												className={cn(
													"inline-flex transition-opacity ease-out",
													showActions || active
														? "opacity-100 duration-300"
														: "opacity-0 duration-0",
												)}
												aria-hidden={!showActions && !active}
											>
												<SortIcon active={active} dir={sortDir} />
											</span>
											{isTags ? (
												<span
													className={cn(
														"size-1.5 shrink-0 rounded-full bg-primary transition-opacity ease-out",
														!showActions && tagFilterActive
															? "opacity-100 duration-300"
															: "opacity-0 duration-0",
													)}
													aria-hidden
												/>
											) : null}
										</button>
										{isTitle && searchEnabled ? (
											<div
												className={cn(
													"relative ml-1 min-w-0 flex-1 transition-opacity ease-out",
													chromeFadeClass,
												)}
												aria-hidden={!showActions}
											>
												<Search
													className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-muted-foreground"
													aria-hidden
												/>
												<Input
													type="search"
													value={inputValue}
													onChange={(e) => onInputChange(e.target.value)}
													aria-label={t("papersLibrary.search")}
													tabIndex={showActions ? undefined : -1}
													className="h-6 border-transparent bg-muted/70 pl-6 pr-1.5 text-xs shadow-none placeholder:text-muted-foreground/70 focus-visible:border-border/60 focus-visible:bg-card"
													onMouseDown={(e) => e.stopPropagation()}
													onClick={(e) => e.stopPropagation()}
													onKeyDown={(e) => e.stopPropagation()}
												/>
											</div>
										) : null}
										{isPublication && canRefreshMetadata ? (
											<Tooltip>
												<TooltipTrigger asChild>
													<button
														type="button"
														data-library-header-action
														tabIndex={showActions ? undefined : -1}
														className={cn(
															"ml-1 flex size-6 shrink-0 items-center justify-center rounded-sm",
															"hover:bg-muted/60 hover:text-foreground",
															"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
															"transition-opacity ease-out",
															chromeFadeClass,
														)}
														aria-hidden={!showActions}
														aria-label={t("papersLibrary.refreshMetadata")}
														onClick={(e) => {
															e.stopPropagation();
															onRefreshMetadata();
														}}
														onMouseDown={(e) => e.stopPropagation()}
													>
														<RefreshCw className="size-3.5" aria-hidden />
													</button>
												</TooltipTrigger>
												<TooltipContent side="bottom">
													{t("papersLibrary.refreshMetadata")}
												</TooltipContent>
											</Tooltip>
										) : null}
										{isTags ? (
											<>
												<Tooltip>
													<TooltipTrigger asChild>
														<button
															type="button"
															data-library-header-action
															disabled={!canFetchRanks}
															tabIndex={showActions ? undefined : -1}
															className={cn(
																"ml-1 flex size-6 shrink-0 items-center justify-center rounded-sm",
																"hover:bg-muted/60 hover:text-foreground",
																"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
																"disabled:pointer-events-none",
																showActions && "disabled:opacity-50",
																"transition-opacity ease-out",
																chromeFadeClass,
															)}
															aria-hidden={!showActions}
															aria-label={t(
																"papersLibrary.easyScholar.fetchRank",
															)}
															title={t("papersLibrary.easyScholar.fetchRank")}
															onClick={(e) => {
																e.stopPropagation();
																void fetchAllRanks();
															}}
															onMouseDown={(e) => e.stopPropagation()}
														>
															<Award className="size-3.5" aria-hidden />
														</button>
													</TooltipTrigger>
													<TooltipContent side="bottom">
														{t("papersLibrary.easyScholar.fetchRank")}
													</TooltipContent>
												</Tooltip>
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
																	tabIndex={showActions ? undefined : -1}
																	className={cn(
																		"ml-auto flex size-6 shrink-0 items-center justify-center rounded-sm",
																		"hover:bg-muted/60 hover:text-foreground",
																		"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
																		"transition-opacity ease-out",
																		chromeFadeClass,
																		tagFilterActive &&
																			showActions &&
																			"bg-muted/60 text-foreground",
																	)}
																	aria-hidden={!showActions}
																	aria-label={t("papersLibrary.filterTags")}
																	aria-pressed={tagFilterActive}
																	onClick={(e) => e.stopPropagation()}
																	onMouseDown={(e) => e.stopPropagation()}
																>
																	<ListFilter
																		className="size-3.5"
																		aria-hidden
																	/>
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
																			onClick={() =>
																				onToggleTagFilter(tag.name)
																			}
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
																					<span className="text-caption leading-none">
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
																	onClick={onClearTagFilter}
																>
																	<X className="size-3" aria-hidden />
																	{t("papersLibrary.clearTagFilter")}
																</button>
															</>
														) : null}
													</PopoverContent>
												</Popover>
											</>
										) : null}
									</div>
									{canCustomizeColumns ? (
										<LibraryColumnResizeHandle
											label={t("papersLibrary.resizeColumn", {
												column: t(meta.labelKey),
											})}
											onResize={(width, commit) =>
												onColumnResize(col.key, width, commit)
											}
										/>
									) : null}
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
						disabled={col.key === "title" || !canCustomizeColumns}
						onSelect={(e) => e.preventDefault()}
						onCheckedChange={() => onToggleColumn(col.key)}
					>
						{t(COLUMN_META[col.key].labelKey)}
					</ContextMenuCheckboxItem>
				))}
				<ContextMenuSeparator />
				<ContextMenuItem
					disabled={!canCustomizeColumns}
					onSelect={() => onResetColumns()}
				>
					{t("papersLibrary.resetColumns")}
				</ContextMenuItem>
			</ContextMenuContent>
		</ContextMenu>
	);
});
