/**
 * Sticky header row for the papers library table.
 *
 * Per-column sort button, title-header inline search, publication refresh,
 * and the tags-filter popover; right-click customizes column order +
 * visibility. Transient drag state (dragKey/dragOverKey) lives here — the
 * parent only receives committed reorder events. Memoized so scrolling the
 * virtualized body does not re-render the header.
 */
import { ListFilter, RefreshCw, Search, X } from "lucide-react";
import { memo, useState } from "react";
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
import { cn } from "@/lib/core/utils";
import type { PaperTag } from "@/lib/paper/tags";
import type { LibraryColumnPref } from "@/lib/settings";

type LibraryTableHeaderProps = {
	t: CellT;
	/** Full column list (order + visibility) for the customization menu. */
	columns: LibraryColumnPref[];
	/** Ordered, visible columns actually rendered as `<th>`. */
	visibleColumns: LibraryColumnPref[];
	sortKey: SortKey;
	sortDir: SortDir;
	onSort: (key: SortKey) => void;
	/** Inline title search; hidden when the shared query is not controlled. */
	searchEnabled: boolean;
	inputValue: string;
	onInputChange: (value: string) => void;
	/** Publication refresh (local vault only). */
	canRefreshPublications: boolean;
	onRefreshPublications: () => void;
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
};

export const LibraryTableHeader = memo(function LibraryTableHeader({
	t,
	columns,
	visibleColumns,
	sortKey,
	sortDir,
	onSort,
	searchEnabled,
	inputValue,
	onInputChange,
	canRefreshPublications,
	onRefreshPublications,
	availableTags,
	tagFilterSet,
	tagFilterActive,
	onToggleTagFilter,
	onClearTagFilter,
	canCustomizeColumns,
	onToggleColumn,
	onResetColumns,
	onColumnReorder,
}: LibraryTableHeaderProps) {
	// --- Column customization (order + visibility) ---
	const [dragKey, setDragKey] = useState<SortKey | null>(null);
	const [dragOverKey, setDragOverKey] = useState<SortKey | null>(null);
	const [tagFilterOpen, setTagFilterOpen] = useState(false);

	return (
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
							const isPublication = col.key === "publication";
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
									draggable={canCustomizeColumns}
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
									<div className="flex min-w-0 items-center gap-1 px-3 py-1.5">
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
											<SortIcon active={active} dir={sortDir} />
										</button>
										{isTitle && searchEnabled ? (
											<div className="relative ml-1 min-w-0 flex-1">
												<Search
													className="pointer-events-none absolute top-1/2 left-1.5 size-3 -translate-y-1/2 text-muted-foreground"
													aria-hidden
												/>
												<Input
													type="search"
													value={inputValue}
													onChange={(e) => onInputChange(e.target.value)}
													aria-label={t("papersLibrary.search")}
													className="h-6 border-transparent bg-muted/50 pl-6 pr-1.5 text-xs shadow-none focus-visible:border-input focus-visible:bg-background"
													onMouseDown={(e) => e.stopPropagation()}
													onClick={(e) => e.stopPropagation()}
													onKeyDown={(e) => e.stopPropagation()}
												/>
											</div>
										) : null}
										{isPublication && canRefreshPublications ? (
											<Tooltip>
												<TooltipTrigger asChild>
													<button
														type="button"
														data-library-header-action
														className={cn(
															"ml-1 flex size-6 shrink-0 items-center justify-center rounded-sm",
															"hover:bg-muted/60 hover:text-foreground",
															"focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
														)}
														aria-label={t("papersLibrary.refreshPublication")}
														onClick={(e) => {
															e.stopPropagation();
															onRefreshPublications();
														}}
														onMouseDown={(e) => e.stopPropagation()}
													>
														<RefreshCw className="size-3.5" aria-hidden />
													</button>
												</TooltipTrigger>
												<TooltipContent side="bottom">
													{t("papersLibrary.refreshPublication")}
												</TooltipContent>
											</Tooltip>
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
																		onClick={() => onToggleTagFilter(tag.name)}
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
																onClick={onClearTagFilter}
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
