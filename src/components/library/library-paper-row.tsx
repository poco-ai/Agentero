/**
 * One virtualized paper row for the library table: selection checkbox plus
 * cells rendered from COLUMN_META. The row context menu lives one level up in
 * `library-row-menu.tsx` so a multi-selection has a single menu instance.
 *
 * Single-click opens the paper (⌘/Shift-click selects instead); double-click a
 * copyable cell copies that field.
 *
 * Memoized — the parent must keep `ctx` (t + onCellCopy) and `measureRef`
 * reference-stable or every scroll re-renders all visible rows.
 */
import type { MouseEvent } from "react";
import { Fragment, memo } from "react";
import { getColumnMeta } from "@/components/library/library-columns";
import type { CellCtx, PaperRow } from "@/components/library/library-row-utils";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/core/utils";
import type { PaperMetadata } from "@/lib/paper";
import type { ReadingHeatmap } from "@/lib/paper/reading-heatmap";
import type { LibraryColumnPref } from "@/lib/settings";

type LibraryPaperRowProps = {
	/** Virtualizer index (`data-index` for measureElement). */
	index: number;
	row: PaperRow;
	heat: ReadingHeatmap | undefined;
	maxReadingTimeMs: number;
	visibleColumns: LibraryColumnPref[];
	/** Stable `t` + `onCellCopy` pair shared by all rows (memo friendly). */
	ctx: Pick<CellCtx, "t" | "onCellCopy">;
	/** Selection mode: draw the leading checkbox cell. */
	showSelection: boolean;
	selected: boolean;
	/** Checkbox click; Shift extends the range from the last anchor. */
	onToggleSelected: (paper: PaperMetadata, mods: { shift: boolean }) => void;
	onRowClick: (
		e: MouseEvent<HTMLTableRowElement>,
		paper: PaperMetadata,
	) => void;
	/** Schedule the row preview; leaving cancels only the pending change. */
	onHoverPaper?: (relPath: string | null) => void;
	onLeavePaper?: () => void;
	/** rowVirtualizer.measureElement — attached to the `<tr>`. */
	measureRef: (element: Element | null) => void;
};

export const LibraryPaperRow = memo(function LibraryPaperRow({
	index,
	row,
	heat,
	maxReadingTimeMs,
	visibleColumns,
	ctx,
	showSelection,
	selected,
	onToggleSelected,
	onRowClick,
	onHoverPaper,
	onLeavePaper,
	measureRef,
}: LibraryPaperRowProps) {
	const p = row.paper;
	const cellCtx: CellCtx = {
		t: ctx.t,
		onCellCopy: ctx.onCellCopy,
		heat,
		readingTimeMs: Number(row.sort.readingTime),
		maxReadingTimeMs,
		tags: row.tags,
	};
	return (
		<tr
			data-index={index}
			data-selected={selected ? "" : undefined}
			ref={measureRef}
			// One hint per paper: the row owns the name/title, so `F` labels
			// every visible paper instead of filling the budget with per-cell
			// copy and tag buttons.
			data-hint
			data-hint-priority="1"
			className={cn(
				"group/row border-border/40 border-b transition-colors duration-100",
				selected ? "bg-primary/10 hover:bg-primary/15" : "hover:bg-accent/70",
			)}
			onClick={(e) => onRowClick(e, p)}
			onMouseEnter={() => onHoverPaper?.(p.path ?? null)}
			onMouseLeave={onLeavePaper}
		>
			{showSelection ? (
				<td className="w-8 min-w-8 p-0 align-middle">
					<div className="flex h-full animate-in items-center justify-center fade-in-0 duration-150">
						<Checkbox
							checked={selected}
							aria-label={ctx.t("papersLibrary.selection.selectRow", {
								title: p.title,
							})}
							className={cn(
								"transition-opacity duration-100",
								!selected && "opacity-60 group-hover/row:opacity-100",
							)}
							onClick={(event) => {
								// Keep the row's open-on-click (and marquee start) out of it.
								event.stopPropagation();
								onToggleSelected(p, { shift: event.shiftKey });
							}}
						/>
					</div>
				</td>
			) : null}
			{visibleColumns.map((col) => (
				<Fragment key={col.key}>
					{getColumnMeta(col.key).render(p, cellCtx)}
				</Fragment>
			))}
			<td className="w-9 min-w-9 p-0" />
		</tr>
	);
});
