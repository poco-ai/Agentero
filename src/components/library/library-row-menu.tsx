/**
 * One context menu for the whole library table.
 *
 * A plain right-click shows the single-row actions; right-clicking a row that
 * is part of a multi-selection shows the batch actions. One shared menu (not
 * one per row) keeps the batch logic in a single place and avoids re-rendering
 * every visible row while a marquee drag changes the selection each frame.
 */
import {
	BookOpen,
	Copy,
	Download,
	FolderOpen,
	MessageSquarePlus,
	Pencil,
	RefreshCw,
	Trash2,
	X,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { useState } from "react";
import {
	type CellT,
	isMissingLocalPdf,
	type PaperRow,
} from "@/components/library/library-row-utils";
import { paperSelectionKey } from "@/components/library/library-selection";
import {
	ContextMenu,
	ContextMenuContent,
	ContextMenuItem,
	ContextMenuLabel,
	ContextMenuSeparator,
	ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { notifyError } from "@/lib/core/notify";
import type { PaperLibraryRow, PaperMetadata } from "@/lib/paper";
import { downloadLibraryPaper } from "@/lib/paper/library-actions";
import { setEditMetaDraft } from "@/lib/paper/library-store";
import type { MenuContext } from "@/lib/shell/commands/menu-contributions";
import {
	activateMenuContribution,
	visibleMenuContributions,
} from "@/lib/shell/commands/menu-contributions";
import { joinVaultPath } from "@/lib/vault";
import { revealInFileManager, revealInOsLabelKey } from "@/lib/vault/reveal";

/**
 * Reads the contribution list when the menu content mounts, not when the
 * table body last rendered. An empty list renders nothing, including no
 * separator.
 */
function LibraryRowMenuContributions({
	vaultPath,
	relPath,
	paperId,
}: {
	vaultPath: string | null;
	relPath: string | undefined;
	paperId: string | undefined;
}) {
	const menuContext: MenuContext = { vaultPath };
	if (relPath) menuContext.relPath = relPath;
	if (paperId) menuContext.paperId = paperId;
	const items = visibleMenuContributions("library.row", menuContext);
	if (items.length === 0) return null;
	return (
		<>
			<ContextMenuSeparator />
			{items.map((item) => (
				<ContextMenuItem
					key={item.id}
					onSelect={() => {
						activateMenuContribution(item, menuContext);
					}}
				>
					{item.title}
				</ContextMenuItem>
			))}
		</>
	);
}

/** Absolute path for an attach/trash call, or null when the row has none. */
function paperAbsPath(paper: PaperMetadata, vaultPath: string | null) {
	if (!paper.path || !vaultPath) return null;
	return joinVaultPath(vaultPath, paper.path);
}

export type LibraryRowMenuProps = {
	/** Rows in table order (the menu resolves `data-index` against it). */
	rows: PaperRow[];
	vaultPath: string | null;
	canEditMeta: boolean;
	selectedKeys: ReadonlySet<string>;
	onOpenPaper: (paper: PaperMetadata) => void;
	onRefreshMetadata?: (paper: PaperMetadata) => void;
	/** Batch actions shared with the floating selection bar. */
	onAddToChat: (papers: PaperLibraryRow[]) => void;
	/** Open the "copy to folder" dialog for these papers. */
	onCopyPapers: (papers: PaperLibraryRow[]) => void;
	onDeletePapers: (papers: PaperLibraryRow[]) => void;
	onClearSelection: () => void;
	/** Right-click preparation: select the row unless it is already selected. */
	onPrepareContext: (key: string) => void;
	t: CellT;
	/** The `<tbody>` the menu is anchored to. */
	children: ReactNode;
};

export function LibraryRowMenu({
	rows,
	vaultPath,
	canEditMeta,
	selectedKeys,
	onOpenPaper,
	onRefreshMetadata,
	onAddToChat,
	onCopyPapers,
	onDeletePapers,
	onClearSelection,
	onPrepareContext,
	t,
	children,
}: LibraryRowMenuProps) {
	/** Row the menu was opened on; null until the first right-click. */
	const [targetKey, setTargetKey] = useState<string | null>(null);

	const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
		const row = (event.target as HTMLElement | null)?.closest<HTMLElement>(
			"tr[data-index]",
		);
		const index = row ? Number(row.dataset.index) : Number.NaN;
		const target = Number.isFinite(index) ? rows[index] : undefined;
		if (!target) {
			setTargetKey(null);
			return;
		}
		const key = paperSelectionKey(target.paper);
		onPrepareContext(key);
		setTargetKey(key);
	};

	const targetRow = targetKey
		? (rows.find((row) => paperSelectionKey(row.paper) === targetKey) ?? null)
		: null;

	const selectedRows: PaperRow[] = targetKey
		? rows.filter((row) => selectedKeys.has(paperSelectionKey(row.paper)))
		: [];
	const bulk = selectedRows.length > 1 && Boolean(targetRow);

	const downloadMissing = () => {
		for (const row of selectedRows) {
			if (isMissingLocalPdf(row.paper)) void downloadLibraryPaper(row.paper);
		}
	};

	return (
		<ContextMenu
			onOpenChange={(next) => {
				// Drop the target on close: the table re-renders on every marquee
				// frame, and a stale target would re-scan all rows each time.
				if (!next) setTargetKey(null);
			}}
		>
			<ContextMenuTrigger asChild onContextMenu={onContextMenu}>
				{children}
			</ContextMenuTrigger>
			<ContextMenuContent className="w-52">
				{bulk ? (
					<>
						<ContextMenuLabel>
							{t("papersLibrary.selection.count", {
								count: selectedRows.length,
							})}
						</ContextMenuLabel>
						<ContextMenuItem
							disabled={selectedRows.length === 0}
							onSelect={() => onAddToChat(selectedRows.map((row) => row.paper))}
						>
							<MessageSquarePlus className="size-3.5" />
							{t("fileTree.addToChat")}
						</ContextMenuItem>
						<ContextMenuItem
							disabled={selectedRows.length === 0}
							onSelect={() =>
								onCopyPapers(selectedRows.map((row) => row.paper))
							}
						>
							<Copy className="size-3.5" />
							{t("papersLibrary.copy.action")}
						</ContextMenuItem>
						{canEditMeta &&
						selectedRows.some((row) => isMissingLocalPdf(row.paper)) ? (
							<ContextMenuItem onSelect={downloadMissing}>
								<Download className="size-3.5" />
								{t("papersLibrary.rowDownloadPdf")}
							</ContextMenuItem>
						) : null}
						<ContextMenuSeparator />
						<ContextMenuItem
							className="text-destructive focus:text-destructive"
							disabled={selectedRows.length === 0}
							onSelect={() =>
								onDeletePapers(selectedRows.map((row) => row.paper))
							}
						>
							<Trash2 className="size-3.5" />
							{t("papersLibrary.selection.delete", {
								count: selectedRows.length,
							})}
						</ContextMenuItem>
						<ContextMenuItem onSelect={onClearSelection}>
							<X className="size-3.5" />
							{t("papersLibrary.selection.clear")}
						</ContextMenuItem>
					</>
				) : targetRow ? (
					<SingleRowMenu
						row={targetRow}
						vaultPath={vaultPath}
						canEditMeta={canEditMeta}
						onOpenPaper={onOpenPaper}
						onRefreshMetadata={onRefreshMetadata}
						onAddToChat={onAddToChat}
						onCopyPapers={onCopyPapers}
						onDeletePapers={onDeletePapers}
						t={t}
					/>
				) : null}
			</ContextMenuContent>
		</ContextMenu>
	);
}

/** Actions for one paper (the pre-multi-select menu, unchanged). */
function SingleRowMenu({
	row,
	vaultPath,
	canEditMeta,
	onOpenPaper,
	onRefreshMetadata,
	onAddToChat,
	onCopyPapers,
	onDeletePapers,
	t,
}: {
	row: PaperRow;
	vaultPath: string | null;
	canEditMeta: boolean;
	onOpenPaper: (paper: PaperMetadata) => void;
	onRefreshMetadata?: (paper: PaperMetadata) => void;
	onAddToChat: (papers: PaperLibraryRow[]) => void;
	onCopyPapers: (papers: PaperLibraryRow[]) => void;
	onDeletePapers: (papers: PaperLibraryRow[]) => void;
	t: CellT;
}) {
	const p = row.paper;
	const absPath = paperAbsPath(p, vaultPath);
	return (
		<>
			<ContextMenuItem onSelect={() => onOpenPaper(p)}>
				<BookOpen className="size-3.5" />
				{t("papersLibrary.rowOpen")}
			</ContextMenuItem>
			{canEditMeta && isMissingLocalPdf(p) ? (
				<ContextMenuItem onSelect={() => void downloadLibraryPaper(p)}>
					<Download className="size-3.5" />
					{t("papersLibrary.rowDownloadPdf")}
				</ContextMenuItem>
			) : null}
			{canEditMeta ? (
				<ContextMenuItem onSelect={() => setEditMetaDraft(p)}>
					<Pencil className="size-3.5" />
					{t("papersLibrary.rowEditMeta")}
				</ContextMenuItem>
			) : null}
			{canEditMeta &&
			onRefreshMetadata &&
			(p.doi?.trim() || p.arxiv_id?.trim() || p.title?.trim()) ? (
				<ContextMenuItem onSelect={() => void onRefreshMetadata?.(p)}>
					<RefreshCw className="size-3.5" />
					{t("papersLibrary.rowRefreshMeta")}
				</ContextMenuItem>
			) : null}
			{absPath ? (
				<>
					<ContextMenuSeparator />
					<ContextMenuItem onSelect={() => onAddToChat([p])}>
						<MessageSquarePlus className="size-3.5" />
						{t("fileTree.addToChat")}
					</ContextMenuItem>
					<ContextMenuItem onSelect={() => onCopyPapers([p])}>
						<Copy className="size-3.5" />
						{t("papersLibrary.copy.action")}
					</ContextMenuItem>
					{canEditMeta ? (
						<ContextMenuItem
							onSelect={() => {
								void revealInFileManager(absPath).catch(() =>
									notifyError(t("fileTree.revealFailed")),
								);
							}}
						>
							<FolderOpen className="size-3.5" />
							{t(revealInOsLabelKey())}
						</ContextMenuItem>
					) : null}
					<ContextMenuItem
						className="text-destructive focus:text-destructive"
						onSelect={() => onDeletePapers([p])}
					>
						<Trash2 className="size-3.5" />
						{t("fileTree.delete")}
					</ContextMenuItem>
				</>
			) : null}
			<LibraryRowMenuContributions
				vaultPath={vaultPath}
				relPath={p.path || undefined}
				paperId={p.id || undefined}
			/>
		</>
	);
}
