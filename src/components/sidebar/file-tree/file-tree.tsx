import {
	forwardRef,
	memo,
	useCallback,
	useImperativeHandle,
	useMemo,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { FileTree as AiFileTree } from "@/components/ai-elements/file-tree";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useSettings } from "@/hooks/use-app-stores";
import { cn } from "@/lib/core/utils";
import type {
	PaperLibraryRow,
	PaperMetadata,
	PaperTreeLabelMode,
	PaperTreeSortMode,
} from "@/lib/paper";
import {
	PLAZA_VIRTUAL_PATH,
	type PlazaSource,
	visiblePlazaSources,
} from "@/lib/plaza";
import type { FileNode } from "@/lib/vault";
import { useMovePicker } from "./hooks/use-move-picker";
import { usePaperRowActions } from "./hooks/use-paper-row-actions";
import { useTexCompile } from "./hooks/use-tex-compile";
import { useTreeContextMenu } from "./hooks/use-tree-context-menu";
import { useTreeDragDrop } from "./hooks/use-tree-drag-drop";
import { useTreeExpansion } from "./hooks/use-tree-expansion";
import { useTreeIndex, useTreeRows } from "./hooks/use-tree-model";
import { useTreeReveal } from "./hooks/use-tree-reveal";
import { useTreeSelection } from "./hooks/use-tree-selection";
import { MovePickerPopover } from "./move-picker-popover";
import { TreeContextMenuPortal } from "./tree-context-menu";
import { pathKey } from "./tree-helpers";
import { TreeCreateInput } from "./tree-inputs";
import { LoadingRows, PlazaRow, PlazaSourceRow, TrashRow } from "./tree-rows";
import { TreeRowsViewport } from "./tree-rows-viewport";
import type { TreeCreateDraft, TreeCreateKind, TreeRenameDraft } from "./types";
import { buildZoteroCollectionReferences } from "./zotero-collection-references";

type FileTreeProps = {
	nodes: FileNode[];
	/** True while the root Vault tree is being loaded. */
	loading?: boolean;
	selectedPath: string | null;
	/** Vault root absolute path — used as create parent for root-level entries. */
	vaultPath: string | null;
	createDraft: TreeCreateDraft | null;
	onConfirmCreate: (name: string) => void;
	onCancelCreate: () => void;
	/** Inline rename draft; replaces the rename dialog for file/folder items. */
	renameDraft?: TreeRenameDraft | null;
	/** Start inline rename for the given tree path. */
	onStartRename?: (path: string) => void;
	/** Confirm inline rename; parent performs the link-aware vault move. */
	onConfirmRename?: (path: string, newName: string) => void | Promise<void>;
	/** Cancel inline rename and clear the draft. */
	onCancelRename?: () => void;
	/** Called for normal files and for paper folders (collapsed leaves). */
	onSelectFile: (node: FileNode) => void;
	/** Virtual library node → papers table in center pane. */
	onSelectLibrary?: () => void;
	/** Virtual trash node → recycle bin view in center pane. */
	onSelectTrash?: () => void;
	/** Virtual 广场 child node → that source's page in center pane. */
	onSelectPlazaSource?: (source: PlazaSource) => void;
	/** Catalog papers used to add Zotero multi-collection references in-place. */
	zoteroCollectionPapers?: PaperLibraryRow[];
	/** Open the real paper selected through that virtual collection view. */
	onOpenZoteroCollectionPaper?: (relPath: string) => void;
	/** Empty recycle bin (confirm + purge). From trash node context menu. */
	onEmptyTrash?: () => void | Promise<void>;
	/** Export library bibliography (Library node context menu). */
	onExportLibrary?: () => void | Promise<void>;
	/** True while export (or other library IO) is in progress — disables menu item. */
	libraryExportBusy?: boolean;
	/** Find new papers citing the library (Library node context menu). */
	onDiscoverCiting?: () => void | Promise<void>;
	/** True while a citation scan is running — disables menu item. */
	citingScanBusy?: boolean;
	/**
	 * Start an inline create rename for a new file/folder under the given parent.
	 * Parent is derived from the right-clicked path (folder itself, or file's parent).
	 */
	onStartCreate?: (kind: TreeCreateKind, parentPath: string) => void;
	/** Download PDF (+ TeX if arXiv); no TeX → liteparse PAPER.md. */
	onDownloadPaperAssets?: (paperNode: FileNode) => Promise<void>;
	/** Download missing assets for every incomplete paper (Library row). */
	onDownloadAllMissingAssets?: () => Promise<void>;
	/**
	 * Catalog paper rows keyed by vault-relative path (for `is_read` / read trigger).
	 * Paths normalized without leading/trailing slashes.
	 */
	paperMetaByRelPath?: ReadonlyMap<string, PaperMetadata>;
	/**
	 * How paper folder rows are labeled (Settings → General).
	 * Display-only; disk folder names are unchanged.
	 */
	paperTreeLabelMode?: PaperTreeLabelMode;
	/**
	 * How siblings under each folder are ordered (Settings → General).
	 * Display-only; does not rename or move disk folders.
	 */
	paperTreeSortMode?: PaperTreeSortMode;
	/** Start paper-reader workflow for a paper folder with complete local assets. */
	onReadPaper?: (paperNode: FileNode) => Promise<void>;
	/** Paper row context menu: open the paper's NOTES.md in the reading split. */
	onOpenPaperNotes?: (paperDir: string) => void;
	/** Paper row context menu: open the catalog metadata editor (local vaults). */
	onEditPaperMeta?: (paperDir: string) => void;
	/** Delete a real tree path (file / folder / paper). Parent confirms + performs IO. */
	onDeletePath?: (path: string) => void | Promise<void>;
	/** Batch delete multiple real tree paths (one confirm). */
	onDeletePaths?: (paths: string[]) => void | Promise<void>;
	/** Move paths into a papers/ folder chosen by the inline picker. */
	onMoveTo?: (paths: string[], destParentRel: string) => void;
	/** Move paths to the destination implied by a drag-and-drop target. */
	onDropMove?: (paths: string[], targetPath: string) => void;
	onCutPaths?: (paths: string[]) => void;
	onPasteInto?: (targetPath: string) => void;
	/** Report the semantic multi-selection count to the fixed sidebar header. */
	onSelectionChange?: (count: number) => void;
	/** Absolute paths currently staged by Cut (for row dimming). */
	cutPaths?: string[];
	/**
	 * OS PDF drop onto a `papers/` org folder → background import in parent.
	 * `parentDir` is vault-relative (e.g. `papers` or `papers/nlp`).
	 * `items` include absolute path + original filename for metadata defaults.
	 */
	onDropLocalPdfs?: (
		items: Array<{ path: string; sourceName: string }>,
		parentDir: string,
	) => void;
	/**
	 * Lazy tree: load children when a folder with `childrenPending` is expanded.
	 * Parent should call `listVaultDirChildren` and merge via `replaceTreeNodeChildren`.
	 */
	onLoadDirChildren?: (dirPath: string) => void | Promise<void>;
	className?: string;
};

/** Imperative tree controls (global shortcuts / command palette). */
export type FileTreeHandle = {
	/** Collapse the selected folder, or its parent if the row is a leaf / already closed. */
	collapseSelected: () => void;
	/** Only expand papers/ (list direct children; do not expand subfolders). */
	collapseToDefault: () => void;
	/** Cut the current multi-selection (or selected path if no multi-selection). */
	cutSelected: () => void;
	/** Paste cut items into the currently selected path. */
	pasteIntoSelected: () => void;
	/** Clear the transient multi-selection mode. */
	clearSelection: () => void;
	/** Open the move picker for the current multi-selection. */
	moveSelected: (anchor: { x: number; y: number }) => void;
	/** Move the current multi-selection to the recycle bin. */
	deleteSelected: () => void;
};

/**
 * Vault sidebar tree. State lives in the `hooks/` modules (derivation, expand,
 * selection, reveal, drag-drop, paper actions, context menu, move picker);
 * this component wires them to the row renderers.
 */
export const FileTree = memo(
	forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
		{
			nodes,
			loading = false,
			selectedPath,
			vaultPath,
			createDraft,
			onConfirmCreate,
			onCancelCreate,
			renameDraft,
			onStartRename,
			onConfirmRename,
			onCancelRename,
			onSelectFile,
			onSelectLibrary,
			onSelectTrash,
			onSelectPlazaSource,
			zoteroCollectionPapers = [],
			onOpenZoteroCollectionPaper,
			onEmptyTrash,
			onExportLibrary,
			libraryExportBusy = false,
			onDiscoverCiting,
			citingScanBusy = false,
			onStartCreate,
			onDownloadPaperAssets,
			onDownloadAllMissingAssets,
			paperMetaByRelPath,
			paperTreeLabelMode = "title-author",
			paperTreeSortMode = "folder",
			onReadPaper,
			onOpenPaperNotes,
			onEditPaperMeta,
			onDeletePath,
			onDeletePaths,
			onMoveTo,
			onDropMove,
			onCutPaths,
			onPasteInto,
			onSelectionChange,
			cutPaths = [],
			onDropLocalPdfs,
			onLoadDirChildren,
			className,
		},
		ref,
	) {
		const { t } = useTranslation("sidebar");
		const plazaEnabled = useSettings((s) => s.plazaEnabled);
		const plazaHiddenSources = useSettings((s) => s.plazaHiddenSources);
		const containerRef = useRef<HTMLDivElement>(null);
		const {
			byPath,
			byPathKey,
			relPathForNode,
			displayNodes,
			treeSelectedPath,
		} = useTreeIndex({
			nodes,
			vaultPath,
			selectedPath,
			paperMetaByRelPath,
			paperTreeLabelMode,
			paperTreeSortMode,
		});
		const zoteroCollectionReferences = useMemo(
			() =>
				buildZoteroCollectionReferences({
					papers: zoteroCollectionPapers,
					vaultPath,
					byPathKey,
				}),
			[zoteroCollectionPapers, vaultPath, byPathKey],
		);

		const expansion = useTreeExpansion({
			nodes,
			vaultPath,
			createDraft,
			byPathKey,
			onLoadDirChildren,
		});

		const { selectableOrder, flatRows } = useTreeRows({
			displayNodes,
			expanded: expansion.expanded,
			createDraft,
			vaultPath,
			plazaEnabled,
			plazaHiddenSources,
			zoteroCollectionReferences,
		});

		const selection = useTreeSelection({
			nodes,
			selectedPath,
			selectableOrder,
			byPath,
			createDraft,
			renameDraft,
			onSelectFile,
			onSelectLibrary,
			onSelectTrash,
			onSelectPlazaSource,
			onOpenZoteroCollectionPaper,
			onTogglePath: expansion.togglePath,
			onDeletePath,
			onDeletePaths,
			onCutPaths,
			onPasteInto,
			onSelectionChange,
		});

		const { treeScrollRef, rowVirtualizer } = useTreeReveal({
			treeSelectedPath,
			flatRows,
			expandAncestorsOf: expansion.expandAncestorsOf,
			suppressAutoRevealRef: expansion.suppressAutoRevealRef,
		});

		const dragDrop = useTreeDragDrop({
			byPath,
			relPathForNode,
			createDraft,
			renameDraft,
			pathsForAction: selection.pathsForAction,
			onDropMove,
			onDropLocalPdfs,
		});

		const paperActions = usePaperRowActions({
			nodes,
			onDownloadPaperAssets,
			onDownloadAllMissingAssets,
			onReadPaper,
		});

		const texCompile = useTexCompile();

		const movePicker = useMovePicker({
			containerRef,
			onMoveTo,
			onMoved: selection.clearSelection,
		});

		const cutPathKeys = useMemo(
			() => new Set(cutPaths.map((p) => pathKey(p))),
			[cutPaths],
		);

		const { menuProps, revealError, handleContextMenuPath } =
			useTreeContextMenu({
				nodes,
				vaultPath,
				byPath,
				cutPaths,
				cutPathKeys,
				createDraft,
				renameDraft,
				libraryExportBusy,
				citingScanBusy,
				pathsForAction: selection.pathsForAction,
				prepareContextSelection: selection.prepareContextSelection,
				openMovePicker: movePicker.openPicker,
				onExportLibrary,
				onDiscoverCiting,
				onDownloadAllMissing: paperActions.showLibraryDownload
					? paperActions.downloadAllMissing
					: undefined,
				onEmptyTrash,
				onOpenPaperNotes,
				onEditPaperMeta,
				onStartCreate,
				onStartRename,
				onDeletePath,
				onDeletePaths,
				onCutPaths,
				onPasteInto,
				onMoveTo,
			});

		const { collapsePaths, collapseToDefault } = expansion;
		const collapseSelected = useCallback(() => {
			const candidates =
				selection.selected.size > 0
					? [...selection.selected]
					: selectedPath
						? [selectedPath]
						: [];
			collapsePaths(candidates);
		}, [selection.selected, selectedPath, collapsePaths]);
		const moveSelected = useCallback(
			(anchor: { x: number; y: number }) => {
				movePicker.openPicker(selection.orderedSelected(), anchor);
			},
			[movePicker.openPicker, selection.orderedSelected],
		);

		useImperativeHandle(
			ref,
			() => ({
				collapseSelected,
				collapseToDefault,
				cutSelected: selection.cutSelected,
				pasteIntoSelected: selection.pasteIntoSelected,
				clearSelection: selection.clearSelection,
				moveSelected,
				deleteSelected: selection.runBatchDelete,
			}),
			[
				collapseSelected,
				collapseToDefault,
				selection.cutSelected,
				selection.pasteIntoSelected,
				selection.clearSelection,
				moveSelected,
				selection.runBatchDelete,
			],
		);

		const trashRow = <TrashRow />;
		const plazaExpanded = expansion.expanded.has(PLAZA_VIRTUAL_PATH);
		const plazaRows = plazaEnabled ? (
			<>
				<PlazaRow expanded={plazaExpanded} />
				{plazaExpanded
					? visiblePlazaSources(plazaHiddenSources).map((source) => (
							<div key={source.id} className="pl-3">
								<PlazaSourceRow source={source} />
							</div>
						))
					: null}
			</>
		) : null;
		const createRow =
			createDraft && vaultPath ? (
				<TreeCreateInput
					key={`create-${createDraft.kind}-${createDraft.parentPath}`}
					kind={createDraft.kind}
					onConfirm={onConfirmCreate}
					onCancel={onCancelCreate}
					parentPath={createDraft.parentPath}
					vaultRoot={vaultPath}
				/>
			) : null;

		return (
			<TooltipProvider delayDuration={300}>
				<div
					ref={containerRef}
					className={cn(
						"relative flex min-h-0 flex-1 flex-col select-none text-sm",
						className,
					)}
				>
					<MovePickerPopover
						picker={movePicker}
						vaultPath={vaultPath}
						nodes={nodes}
					/>
					<div
						ref={treeScrollRef}
						className="agentero-scroll min-h-0 flex-1 overflow-y-auto py-1 [scrollbar-gutter:stable]"
					>
						{nodes.length === 0 && !createDraft ? (
							<>
								{/* Trash + 广场 always available (empty vault or no vault yet). */}
								<AiFileTree
									selectedPath={treeSelectedPath}
									selectedPaths={selection.selected}
									expanded={expansion.expanded}
									onExpandedChange={expansion.setExpandedFromTree}
									onContextMenuPath={handleContextMenuPath}
									onSelectRow={selection.handleSelectRow}
								>
									{trashRow}
									{plazaRows}
								</AiFileTree>
								{vaultPath && loading ? (
									<LoadingRows />
								) : vaultPath ? (
									<p className="px-3 py-2 text-muted-foreground text-xs">
										{t("fileTree.empty")}
									</p>
								) : null}
							</>
						) : (
							<AiFileTree
								selectedPath={treeSelectedPath}
								selectedPaths={selection.selected}
								expanded={expansion.expanded}
								onExpandedChange={expansion.setExpandedFromTree}
								onContextMenuPath={handleContextMenuPath}
								onSelectRow={selection.handleSelectRow}
								dropTargetPath={dragDrop.dropTarget}
								onRowDragStart={dragDrop.handleRowDragStart}
								onRowDragOver={dragDrop.handleRowDragOver}
								onRowDrop={dragDrop.handleRowDrop}
								onRowDragEnd={dragDrop.handleRowDragEnd}
							>
								<TreeRowsViewport
									flatRows={flatRows}
									rowVirtualizer={rowVirtualizer}
									trashRow={trashRow}
									createRow={createRow}
									renameDraft={renameDraft}
									onConfirmRename={onConfirmRename}
									onCancelRename={onCancelRename}
									cutPathKeys={cutPathKeys}
									expanded={expansion.expanded}
									loadingDirs={expansion.loadingDirs}
									relPathForNode={relPathForNode}
									paperMetaByRelPath={paperMetaByRelPath}
									paperTreeLabelMode={paperTreeLabelMode}
									paperActions={paperActions}
									texCompile={texCompile}
									vaultPath={vaultPath}
								/>
							</AiFileTree>
						)}
						{revealError ? (
							<p className="px-3 py-1 text-destructive text-xs leading-snug">
								{revealError}
							</p>
						) : null}
					</div>
					{menuProps ? <TreeContextMenuPortal {...menuProps} /> : null}
				</div>
			</TooltipProvider>
		);
	}),
);
