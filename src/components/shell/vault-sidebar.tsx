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
import { PaperInfoPanel } from "@/components/sidebar/paper-info-panel";
import {
	useLibraryStore,
	useSettings,
	useUiStore,
	useVaultStore,
	useWorkspaceStore,
} from "@/hooks/use-app-stores";
import type { PaperMetadata, PaperTag } from "@/lib/paper";
import { resolvePapersParentDir } from "@/lib/paper";
import {
	dropLocalPdfs,
	importLocalPdf,
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
import { vaultDisplayName } from "@/lib/vault";
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
	openPaperNotes,
	openPlazaSource,
	selectFileNode,
	selectLibrary,
	selectTrash,
} from "@/lib/workspace/actions";

// Stable callbacks so the memoized header / tree bail out on unrelated renders.
const onLookupSubmit = (texts: string[]) => lookupSubmit(texts);
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
const onEmptyTrash = () => void emptyTrash();
const onExportLibrary = () => void libraryExport();
const onDiscoverCiting = () => void discoverCitingPapers();

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
	const createDraft = useVaultStore((s) => s.createDraft);
	const renameDraft = useVaultStore((s) => s.renameDraft);
	const busy = useVaultStore((s) => s.busy);
	const recentVaults = useVaultStore((s) => s.recentVaults);
	const cutPaths = useVaultStore((s) => s.cutPaths);
	const ioBusy = useLibraryStore((s) => s.ioBusy);
	const paperMetaByRelPath = useLibraryStore((s) => s.paperMetaByRelPath);
	const lookupOpenSignal = useUiStore((s) => s.lookupOpenSignal);
	const paperTreeLabelMode = useSettings((s) => s.paperTreeLabelMode);
	const paperTreeSortMode = useSettings((s) => s.paperTreeSortMode);
	const paperMeta = useWorkspaceStore(
		(s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.paperMeta ?? null,
	);
	const [lastPaper, setLastPaper] = useState<{
		vaultPath: string | null;
		meta: PaperMetadata | null;
	}>({ vaultPath: null, meta: null });

	useEffect(() => {
		if (paperMeta) {
			setLastPaper({ vaultPath, meta: paperMeta });
			return;
		}
		setLastPaper((previous) =>
			previous.vaultPath === vaultPath ? previous : { vaultPath, meta: null },
		);
	}, [paperMeta, vaultPath]);

	const selectedPaperMeta =
		paperMeta ?? (lastPaper.vaultPath === vaultPath ? lastPaper.meta : null);
	// Library tag edits update the catalog store while the open tab may retain an older snapshot.
	const selectedPaperPath = selectedPaperMeta?.path
		.replace(/\\/g, "/")
		.replace(/^\/+|\/+$/g, "");
	const displayedPaperMeta = selectedPaperPath
		? (paperMetaByRelPath.get(selectedPaperPath) ?? selectedPaperMeta)
		: selectedPaperMeta;
	const onPaperTagsChange = useCallback(
		async (tags: PaperTag[]) => {
			if (!displayedPaperMeta) return;
			const updated = await paperTagsChange(displayedPaperMeta, tags);
			if (updated) setLastPaper({ vaultPath, meta: updated });
		},
		[displayedPaperMeta, vaultPath],
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
					onPasteInto={(target) => void pasteCutPaths(target)}
					onSelectionChange={setTreeSelectionCount}
					cutPaths={cutPaths}
					onDropLocalPdfs={dropLocalPdfs}
					onSelectFile={selectFileNode}
					onSelectLibrary={selectLibrary}
					onSelectTrash={selectTrash}
					onSelectPlazaSource={openPlazaSource}
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
			{/* Paper info is a resizable, unboxed section below the file tree. */}
			{displayedPaperMeta ? (
				<PaperInfoPanel
					meta={displayedPaperMeta}
					onTagsChange={onPaperTagsChange}
				/>
			) : null}
		</>
	);
}
