/**
 * One virtualized paper row for the library table: cells rendered from
 * COLUMN_META plus the row context menu (open / download / edit / reveal /
 * delete / add-to-chat).
 *
 * Memoized — the parent must keep `ctx` (t + onCellCopy) and `measureRef`
 * reference-stable or every scroll re-renders all visible rows.
 */
import {
	BookOpen,
	Download,
	FolderOpen,
	MessageSquarePlus,
	Pencil,
	Trash2,
} from "lucide-react";
import { Fragment, memo } from "react";
import { COLUMN_META } from "@/components/library/library-columns";
import type { CellCtx, PaperRow } from "@/components/library/library-row-utils";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { broadcastAgentAttachContext } from "@/lib/agent/context-attach";
import { notifyError } from "@/lib/core/notify";
import type { PaperMetadata } from "@/lib/paper";
import { downloadLibraryPaper } from "@/lib/paper/library-actions";
import { setEditMetaDraft } from "@/lib/paper/library-store";
import type { ReadingHeatmap } from "@/lib/paper/reading-heatmap";
import type { LibraryColumnPref } from "@/lib/settings";
import { trashPathsAndNotify } from "@/lib/vault/actions";
import { revealInFileManager, revealInOsLabelKey } from "@/lib/vault/reveal";

type LibraryPaperRowProps = {
	/** Virtualizer index (`data-index` for measureElement). */
	index: number;
	row: PaperRow;
	heat: ReadingHeatmap | undefined;
	visibleColumns: LibraryColumnPref[];
	/** Stable `t` + `onCellCopy` pair shared by all rows (memo friendly). */
	ctx: Pick<CellCtx, "t" | "onCellCopy">;
	paperAbsPath: string | null;
	canEditMeta: boolean;
	onOpenPaper: (paper: PaperMetadata) => void;
	/** rowVirtualizer.measureElement — attached to the `<tr>`. */
	measureRef: (element: Element | null) => void;
};

export const LibraryPaperRow = memo(function LibraryPaperRow({
	index,
	row,
	heat,
	visibleColumns,
	ctx,
	paperAbsPath,
	canEditMeta,
	onOpenPaper,
	measureRef,
}: LibraryPaperRowProps) {
	const p = row.paper;
	const cellCtx: CellCtx = {
		t: ctx.t,
		onCellCopy: ctx.onCellCopy,
		heat,
		tags: row.tags,
	};
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<tr
					data-index={index}
					ref={measureRef}
					className="border-b border-border/60 transition-colors hover:bg-muted/50"
					onDoubleClick={() => onOpenPaper(p)}
				>
					{visibleColumns.map((col) => (
						<Fragment key={col.key}>
							{COLUMN_META[col.key].render(p, cellCtx)}
						</Fragment>
					))}
				</tr>
			</ContextMenuTrigger>
			<ContextMenuContent className="w-44">
				<ContextMenuItem onSelect={() => onOpenPaper(p)}>
					<BookOpen className="size-3.5" />
					{ctx.t("papersLibrary.rowOpen")}
				</ContextMenuItem>
				{canEditMeta && p.has_pdf === false ? (
					<ContextMenuItem onSelect={() => void downloadLibraryPaper(p)}>
						<Download className="size-3.5" />
						{ctx.t("papersLibrary.rowDownloadPdf")}
					</ContextMenuItem>
				) : null}
				{canEditMeta ? (
					<ContextMenuItem onSelect={() => setEditMetaDraft(p)}>
						<Pencil className="size-3.5" />
						{ctx.t("papersLibrary.rowEditMeta")}
					</ContextMenuItem>
				) : null}
				{paperAbsPath ? (
					<>
						<ContextMenuSeparator />
						<ContextMenuItem
							onSelect={() => broadcastAgentAttachContext([paperAbsPath])}
						>
							<MessageSquarePlus className="size-3.5" />
							{ctx.t("fileTree.addToChat")}
						</ContextMenuItem>
						{canEditMeta ? (
							<ContextMenuItem
								onSelect={() => {
									void revealInFileManager(paperAbsPath).catch(() =>
										notifyError(ctx.t("fileTree.revealFailed")),
									);
								}}
							>
								<FolderOpen className="size-3.5" />
								{ctx.t(revealInOsLabelKey())}
							</ContextMenuItem>
						) : null}
						<ContextMenuItem
							className="text-destructive focus:text-destructive"
							onSelect={() => void trashPathsAndNotify([paperAbsPath])}
						>
							<Trash2 className="size-3.5" />
							{ctx.t("fileTree.delete")}
						</ContextMenuItem>
					</>
				) : null}
			</ContextMenuContent>
		</ContextMenu>
	);
});
