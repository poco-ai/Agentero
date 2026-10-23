/**
 * Left rail: vault header (magic wand / recents / import), file tree, and the
 * Paper Info panel. Subscribes to the vault/library/ui stores directly so
 * tree updates no longer re-render the whole App.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { registerFileTreeHandle } from "@/components/shell/file-tree-registry";
import {
	FileTree,
	type FileTreeHandle,
	VaultSidebarHeader,
} from "@/components/sidebar/file-tree";
import { LatexPanel } from "@/components/sidebar/latex-panel";
import { PaperInfoPanel } from "@/components/sidebar/paper-info-panel";
import { useTexProject } from "@/components/sidebar/use-tex-project";
import {
	useLibraryStore,
	useSettings,
	useUiStore,
	useVaultStore,
	useWorkspaceStore,
} from "@/hooks/use-app-stores";
import type { PaperTag } from "@/lib/paper";
import {
	isPaperDirectory,
	paperDirFromPath,
	resolvePapersParentDir,
} from "@/lib/paper";
import {
	dropLocalPdfs,
	importLocalPdf,
	lookupBatchSubmit,
	lookupSubmit,
} from "@/lib/paper/import-actions";
import {
	discoverCitingPapers,
	downloadAllMissingAssets,
	downloadPaperAssetsAction,
	editPaperMetaFromTree,
	libraryExport,
	libraryImport,
	paperTagsChange,
	readPaper,
} from "@/lib/paper/library-actions";
import { setZoteroOpen, setZoteroSyncOpen } from "@/lib/shell/ui-store";
import {
	joinVaultPath,
	treeFindNode,
	vaultDisplayName,
	vaultRelativePath,
} from "@/lib/vault";
import {
	cancelCreate,
	cancelRenamePath,
	confirmCreate,
	confirmRenamePath,
	createNewVault,
	cutSelectedPaths,
	dropMovePaths,
	emptyTrash,
	movePathsTo,
	openRecentVault,
	openRemoteVault,
	openVault,
	pasteCutPaths,
	removeRecent,
	startCreate,
	startRenamePath,
	trashPathsAndNotify,
} from "@/lib/vault/actions";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";
import { loadDirChildren } from "@/lib/vault/store";
import {
	openPaper,
	openPaperNotes,
	openPlazaSource,
	selectFileNode,
	selectLibrary,
	selectTrash,
} from "@/lib/workspace/actions";

// Stable callbacks so the memoized header / tree bail out on unrelated renders.
const onLookupSubmit = (texts: string[]) => lookupSubmit(texts);
const onLookupBatchSubmit = (texts: string[]) => lookupBatchSubmit(texts);
const onImportBibliography = () => void libraryImport();
const onImportLocalPdf = () => void importLocalPdf();
const onOpenRecent = (p: string) => void openRecentVault(p);
const onOpenVaultClick = () => void openVault();
const onCreateVaultClick = () => void createNewVault();
const onOpenRemoteVaultClick = (args: {
	host: string;
	user?: string;
	remotePath: string;
}) => void openRemoteVault(args);
const onMigrateZotero = () => setZoteroOpen(true);
const onSyncZotero = () => setZoteroSyncOpen(true);
const onConfirmCreate = (name: string) => void confirmCreate(name);
const onConfirmRename = (path: string, name: string) =>
	void confirmRenamePath(path, name);
const onCancelRename = () => cancelRenamePath();
const onDeletePath = (path: string) => void trashPathsAndNotify([path]);
const onDeletePaths = (paths: string[]) => void trashPathsAndNotify(paths);
const onMoveTo = (paths: string[], dest: string) =>
	void movePathsTo(paths, dest);
const onDropMove = (paths: string[], targetPath: string) =>
	void dropMovePaths(paths, targetPath);
const onPasteInto = (targetPath: string) => void pasteCutPaths(targetPath);
const onEmptyTrash = () => void emptyTrash();
const onExportLibrary = () => void libraryExport();
const onDiscoverCiting = () => void discoverCitingPapers();

/** Catalog keys are vault-relative with forward slashes and no edge slashes. */
function normalizePaperRelPath(path: string | null | undefined): string | null {
	if (!path) return null;
	const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	return normalized || null;
}

export function VaultSidebar() {
	const fileTreeRef = useRef<FileTreeHandle>(null);
	const [treeSelectionCount, setTreeSelectionCount] = useState(0);
	useEffect(() => {
		registerFileTreeHandle(fileTreeRef.current);
		return () => registerFileTreeHandle(null);
	});
	const { t } = useTranslation(["app", "sidebar"]);
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const tree = useVaultStore((s) => s.tree);
	const treeLoading = useVaultStore((s) => s.treeLoading);
	const treeSelectedPath = useVaultStore((s) => s.treeSelectedPath);
	const paperFolders = useVaultStore((s) => s.paperFolders);
	const createDraft = useVaultStore((s) => s.createDraft);
	const renameDraft = useVaultStore((s) => s.renameDraft);
	const busy = useVaultStore((s) => s.busy);
	const recentVaults = useVaultStore((s) => s.recentVaults);
	const cutPaths = useVaultStore((s) => s.cutPaths);
	const ioBusy = useLibraryStore((s) => s.ioBusy);
	const paperMetaByRelPath = useLibraryStore((s) => s.paperMetaByRelPath);
	const papers = useLibraryStore((s) => s.papers);
	const lookupOpenSignal = useUiStore((s) => s.lookupOpenSignal);
	const hoveredPaperPath = useUiStore((s) => s.hoveredPaperPath);
	const paperTreeLabelMode = useSettings((s) => s.paperTreeLabelMode);
	const paperTreeSortMode = useSettings((s) => s.paperTreeSortMode);
	const activeTab = useWorkspaceStore(
		(s) => s.tabs.find((tab) => tab.id === s.activeTabId) ?? null,
	);
	const paperMeta = activeTab?.paperMeta ?? null;
	// Any file inside a TeX project (the PDF, a chapter, a figure) keeps
	// the LaTeX panel. Library hover does not override it.
	const texProjectPath = useTexProject(
		vaultPath,
		activeTab?.path ?? null,
		activeTab?.texRoot,
	);

	// While a paper / note tab hydrates, its own `paperMeta` is still null.
	// Resolve the owning paper from the tree/path so Paper Info does not
	// unmount/remount and resize the tree viewport mid-open (WebKit
	// blank-until-scroll, #738).
	const fallbackPaperRel = useMemo(() => {
		if (!activeTab || !vaultPath || activeTab.paperMeta) return null;
		const treeNode = treeFindNode(tree, activeTab.path);
		const paperAbs =
			treeNode?.kind === "directory" &&
			isPaperDirectory(treeNode.path, treeNode.children)
				? treeNode.path
				: paperDirFromPath(activeTab.path, paperFolders);
		if (!paperAbs) return null;
		return normalizePaperRelPath(vaultRelativePath(vaultPath, paperAbs));
	}, [activeTab, vaultPath, paperFolders, tree]);

	// Prefer the catalog snapshot: library tag edits update it while the open
	// tab may still hold an older copy.
	const activePaperPath = normalizePaperRelPath(
		paperMeta?.path ?? fallbackPaperRel,
	);
	const activePaperMeta = activePaperPath
		? (paperMetaByRelPath.get(activePaperPath) ?? paperMeta)
		: paperMeta;
	// Hovering a Library row previews that paper without opening it.
	const hoveredPaperKey = normalizePaperRelPath(hoveredPaperPath);
	const hoveredPaperMeta = hoveredPaperKey
		? (paperMetaByRelPath.get(hoveredPaperKey) ?? null)
		: null;
	// Auto-hide on non-paper surfaces; only papers and Library hover are shown.
	const displayedPaperMeta = activePaperMeta ?? hoveredPaperMeta;
	const onPaperTagsChange = useCallback(
		async (tags: PaperTag[]) => {
			if (!displayedPaperMeta) return;
			await paperTagsChange(displayedPaperMeta, tags);
		},
		[displayedPaperMeta],
	);
	const onOpenZoteroCollectionPaper = useCallback(
		(relPath: string) => {
			if (!vaultPath) return;
			// Keep the user in the read-only Zotero hierarchy; the reference still
			// opens its one real paper folder, without scrolling the physical tree.
			openPaper(joinVaultPath(vaultPath, relPath), { revealTree: false });
		},
		[vaultPath],
	);

	const lookupParentDir = useMemo(
		() => resolvePapersParentDir(vaultPath, treeSelectedPath, tree),
		[vaultPath, treeSelectedPath, tree],
	);
	const clearTreeSelection = useCallback(
		() => fileTreeRef.current?.clearSelection(),
		[],
	);
	const moveTreeSelection = useCallback(
		(anchor: { x: number; y: number }) =>
			fileTreeRef.current?.moveSelected(anchor),
		[],
	);
	const deleteTreeSelection = useCallback(
		() => fileTreeRef.current?.deleteSelected(),
		[],
	);
	const treeSelectionHeader = useMemo(
		() =>
			treeSelectionCount > 0
				? {
						count: treeSelectionCount,
						disabled: busy,
						onClear: clearTreeSelection,
						onMove: moveTreeSelection,
						onDelete: deleteTreeSelection,
					}
				: undefined,
		[
			busy,
			clearTreeSelection,
			deleteTreeSelection,
			moveTreeSelection,
			treeSelectionCount,
		],
	);

	return (
		<>
			<div className="shrink-0">
				<VaultSidebarHeader
					title={
						vaultPath && isRemoteVaultHandle(vaultPath)
							? `${vaultDisplayName(vaultPath)} · ${t("app:vault.remoteBadge")}`
							: vaultDisplayName(vaultPath)
					}
					selection={treeSelectionHeader}
					lookupParentDir={lookupParentDir}
					onLookupSubmit={onLookupSubmit}
					onLookupBatchSubmit={onLookupBatchSubmit}
					onImportBibliography={onImportBibliography}
					onImportLocalPdf={onImportLocalPdf}
					importBusy={ioBusy === "import"}
					importPdfBusy={ioBusy === "import-pdf"}
					busy={busy}
					isDemo={vaultPath === null}
					lookupOpenSignal={lookupOpenSignal}
					recentVaults={recentVaults}
					vaultPath={vaultPath}
					onOpenRecent={onOpenRecent}
					onRemoveRecent={removeRecent}
					onOpenVault={onOpenVaultClick}
					onCreateVault={onCreateVaultClick}
					onOpenRemoteVault={onOpenRemoteVaultClick}
					onMigrateZotero={onMigrateZotero}
					onSyncZotero={onSyncZotero}
				/>
			</div>
			<div className="flex min-h-0 flex-1 flex-col pl-1">
				<FileTree
					ref={fileTreeRef}
					nodes={tree}
					loading={treeLoading}
					selectedPath={treeSelectedPath}
					vaultPath={vaultPath}
					createDraft={createDraft}
					onConfirmCreate={onConfirmCreate}
					onCancelCreate={cancelCreate}
					renameDraft={renameDraft}
					onStartRename={startRenamePath}
					onConfirmRename={onConfirmRename}
					onCancelRename={onCancelRename}
					onDeletePath={onDeletePath}
					onDeletePaths={onDeletePaths}
					onMoveTo={onMoveTo}
					onDropMove={onDropMove}
					onCutPaths={cutSelectedPaths}
					onPasteInto={onPasteInto}
					onSelectionChange={setTreeSelectionCount}
					cutPaths={cutPaths}
					onDropLocalPdfs={dropLocalPdfs}
					onSelectFile={selectFileNode}
					onSelectLibrary={selectLibrary}
					onSelectTrash={selectTrash}
					onSelectPlazaSource={openPlazaSource}
					zoteroCollectionPapers={papers}
					onOpenZoteroCollectionPaper={onOpenZoteroCollectionPaper}
					onEmptyTrash={onEmptyTrash}
					onExportLibrary={onExportLibrary}
					libraryExportBusy={ioBusy === "export"}
					onDiscoverCiting={onDiscoverCiting}
					citingScanBusy={ioBusy !== null}
					onStartCreate={startCreate}
					onDownloadPaperAssets={downloadPaperAssetsAction}
					onDownloadAllMissingAssets={downloadAllMissingAssets}
					paperMetaByRelPath={paperMetaByRelPath}
					paperTreeLabelMode={paperTreeLabelMode}
					paperTreeSortMode={paperTreeSortMode}
					onReadPaper={readPaper}
					onOpenPaperNotes={openPaperNotes}
					onEditPaperMeta={
						vaultPath && !isRemoteVaultHandle(vaultPath)
							? editPaperMetaFromTree
							: undefined
					}
					onLoadDirChildren={loadDirChildren}
				/>
			</div>
			{/* Paper info is a resizable, unboxed section below the file tree.
			    A TeX project uses the same slot for compile + outline. */}
			{texProjectPath ? (
				<LatexPanel texPath={texProjectPath} />
			) : displayedPaperMeta ? (
				<PaperInfoPanel
					meta={displayedPaperMeta}
					onTagsChange={onPaperTagsChange}
				/>
			) : null}
		</>
	);
}
