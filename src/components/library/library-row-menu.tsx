/**
 * One context menu for the library content area.
 *
 * Right-click a paper for single or batch actions, or the background for
 * actions scoped to the current folder.
 */
import {
	BookOpen,
	Copy,
	Download,
	FolderOpen,
	Loader2,
	MessageSquarePlus,
	Pencil,
	RefreshCw,
	Trash2,
	X,
} from "lucide-react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { createContext, useContext, useState } from "react";
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
import {
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { notifyError } from "@/lib/core/notify";
import type { PaperLibraryRow, PaperMetadata } from "@/lib/paper";
import {
	downloadLibraryPaper,
	recaptureWebpageSnapshot,
} from "@/lib/paper/library-actions";
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
	Item,
	Separator,
}: {
	vaultPath: string | null;
	relPath: string | undefined;
	paperId: string | undefined;
	Item: typeof ContextMenuItem | typeof DropdownMenuItem;
	Separator: typeof ContextMenuSeparator | typeof DropdownMenuSeparator;
}) {
	const menuContext: MenuContext = { vaultPath };
	if (relPath) menuContext.relPath = relPath;
	if (paperId) menuContext.paperId = paperId;
	const items = visibleMenuContributions("library.row", menuContext);
	if (items.length === 0) return null;
	return (
		<>
			<Separator />
			{items.map((item) => (
				<Item
					key={item.id}
					onSelect={() => {
						activateMenuContribution(item, menuContext);
					}}
				>
					{item.title}
				</Item>
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
	/** Visible papers in display order (the menu resolves `data-index` against it). */
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
	backgroundItems?: ReactNode;
	children: ReactNode;
};

const PaperMenuContext = createContext<{
	props: Omit<
		LibraryRowMenuProps,
		"backgroundItems" | "children" | "onPrepareContext"
	>;
	recapturingKeys: ReadonlySet<string>;
	onRecaptureWebpage: (paper: PaperMetadata) => void;
} | null>(null);

export function LibraryRowMenu({
	backgroundItems,
	onPrepareContext,
	children,
	...props
}: LibraryRowMenuProps) {
	const { rows, vaultPath } = props;
	/** Row the menu was opened on; null until the first right-click. */
	const [targetKey, setTargetKey] = useState<string | null>(null);
	/** Papers whose webpage snapshot is being re-fetched (row busy). */
	const [recapturingKeys, setRecapturingKeys] = useState<ReadonlySet<string>>(
		() => new Set(),
	);

	const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
		if (event.defaultPrevented) return;
		if (!event.currentTarget.contains(event.target as Node)) {
			event.preventDefault();
			return;
		}
		const element = event.target as Element;
		const row = element.closest<HTMLElement>(
			"[data-library-paper][data-index]",
		);
		const index = row ? Number(row.dataset.index) : Number.NaN;
		const target = Number.isFinite(index) ? rows[index] : undefined;
		if (!target) {
			setTargetKey(null);
			if (
				!backgroundItems ||
				element.closest(
					"[data-library-card], thead, button, a, input, textarea, [role='menu']",
				)
			) {
				event.preventDefault();
			}
			return;
		}
		const key = paperSelectionKey(target.paper);
		onPrepareContext(key);
		setTargetKey(key);
	};

	const targetRow = targetKey
		? (rows.find((row) => paperSelectionKey(row.paper) === targetKey) ?? null)
		: null;

	const recaptureWebpage = (paper: PaperMetadata) => {
		const key = paperSelectionKey(paper);
		if (recapturingKeys.has(key)) return;
		setRecapturingKeys((prev) => new Set(prev).add(key));
		void recaptureWebpageSnapshot(vaultPath, paper).finally(() => {
			setRecapturingKeys((prev) => {
				const next = new Set(prev);
				next.delete(key);
				return next;
			});
		});
	};

	return (
		<PaperMenuContext.Provider
			value={{ props, recapturingKeys, onRecaptureWebpage: recaptureWebpage }}
		>
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
					{targetRow ? (
						<LibraryPaperMenuItems row={targetRow} mode="context" />
					) : (
						backgroundItems
					)}
				</ContextMenuContent>
			</ContextMenu>
		</PaperMenuContext.Provider>
	);
}

export function LibraryPaperMenuItems({
	row,
	mode,
}: {
	row: PaperRow;
	mode: "context" | "dropdown";
}) {
	const menu = useContext(PaperMenuContext);
	if (!menu) return null;
	const { props, recapturingKeys, onRecaptureWebpage } = menu;
	const {
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
		t,
	} = props;
	const Item = mode === "dropdown" ? DropdownMenuItem : ContextMenuItem;
	const Separator =
		mode === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator;
	const Label = mode === "dropdown" ? DropdownMenuLabel : ContextMenuLabel;
	const key = paperSelectionKey(row.paper);
	const selectedRows =
		selectedKeys.size > 1 && selectedKeys.has(key)
			? rows.filter(({ paper }) => selectedKeys.has(paperSelectionKey(paper)))
			: [];
	if (selectedRows.length > 1 && selectedRows.length === selectedKeys.size) {
		const selectedPapers = selectedRows.map(({ paper }) => paper);
		const missing = selectedPapers.filter(isMissingLocalPdf);
		return (
			<>
				<Label>
					{t("papersLibrary.selection.count", {
						count: selectedRows.length,
					})}
				</Label>
				<Item onSelect={() => onAddToChat(selectedPapers)}>
					<MessageSquarePlus className="size-3.5" />
					{t("fileTree.addToChat")}
				</Item>
				<Item onSelect={() => onCopyPapers(selectedPapers)}>
					<Copy className="size-3.5" />
					{t("papersLibrary.copy.action")}
				</Item>
				{canEditMeta && missing.length > 0 ? (
					<Item
						onSelect={() => {
							for (const paper of missing) void downloadLibraryPaper(paper);
						}}
					>
						<Download className="size-3.5" />
						{t("papersLibrary.rowDownloadPdf")}
					</Item>
				) : null}
				<Separator />
				<Item
					className="text-destructive focus:text-destructive"
					onSelect={() => onDeletePapers(selectedPapers)}
				>
					<Trash2 className="size-3.5" />
					{t("papersLibrary.selection.delete", {
						count: selectedRows.length,
					})}
				</Item>
				<Item onSelect={onClearSelection}>
					<X className="size-3.5" />
					{t("papersLibrary.selection.clear")}
				</Item>
			</>
		);
	}
	const recapturing = recapturingKeys.has(key);
	const p = row.paper;
	const absPath = paperAbsPath(p, vaultPath);
	return (
		<>
			<Item onSelect={() => onOpenPaper(p)}>
				<BookOpen className="size-3.5" />
				{t("papersLibrary.rowOpen")}
			</Item>
			{canEditMeta && isMissingLocalPdf(p) ? (
				<Item onSelect={() => void downloadLibraryPaper(p)}>
					<Download className="size-3.5" />
					{t("papersLibrary.rowDownloadPdf")}
				</Item>
			) : null}
			{canEditMeta ? (
				<Item onSelect={() => setEditMetaDraft(p)}>
					<Pencil className="size-3.5" />
					{t("papersLibrary.rowEditMeta")}
				</Item>
			) : null}
			{canEditMeta &&
			onRefreshMetadata &&
			(p.doi?.trim() || p.arxiv_id?.trim() || p.title?.trim()) ? (
				<Item onSelect={() => void onRefreshMetadata?.(p)}>
					<RefreshCw className="size-3.5" />
					{t("papersLibrary.rowRefreshMeta")}
				</Item>
			) : null}
			{canEditMeta && p.type === "html" ? (
				<Item disabled={recapturing} onSelect={() => onRecaptureWebpage(p)}>
					{recapturing ? (
						<Loader2 className="size-3.5 animate-spin" />
					) : (
						<RefreshCw className="size-3.5" />
					)}
					{t("papersLibrary.rowRecaptureWebpage")}
				</Item>
			) : null}
			{absPath ? (
				<>
					<Separator />
					<Item onSelect={() => onAddToChat([p])}>
						<MessageSquarePlus className="size-3.5" />
						{t("fileTree.addToChat")}
					</Item>
					<Item onSelect={() => onCopyPapers([p])}>
						<Copy className="size-3.5" />
						{t("papersLibrary.copy.action")}
					</Item>
					{canEditMeta ? (
						<Item
							onSelect={() => {
								void revealInFileManager(absPath).catch(() =>
									notifyError(t("fileTree.revealFailed")),
								);
							}}
						>
							<FolderOpen className="size-3.5" />
							{t(revealInOsLabelKey())}
						</Item>
					) : null}
					<Item
						className="text-destructive focus:text-destructive"
						onSelect={() => onDeletePapers([p])}
					>
						<Trash2 className="size-3.5" />
						{t("fileTree.delete")}
					</Item>
				</>
			) : null}
			<LibraryRowMenuContributions
				Item={Item}
				Separator={Separator}
				vaultPath={vaultPath}
				relPath={p.path || undefined}
				paperId={p.id || undefined}
			/>
		</>
	);
}
