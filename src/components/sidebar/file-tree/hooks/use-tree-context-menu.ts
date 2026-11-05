/**
 * Right-click menu state for the vault tree: which row is targeted, the derived
 * menu capabilities, and every menu action (reveal, terminal, create, rename,
 * cut/paste, move, delete, library export, empty trash).
 */
import {
	type MouseEvent as ReactMouseEvent,
	useCallback,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "@/lib/core/error";
import {
	isPaperDirectory,
	isPapersRoot,
	type PaperMetadata,
} from "@/lib/paper";
import { TRASH_VIRTUAL_PATH } from "@/lib/paper/api";
import { PLAZA_SOURCES, PLAZA_VIRTUAL_PATH } from "@/lib/plaza";
import { getSettings, patchSettings } from "@/lib/settings/react-store";
import {
	type FileNode,
	resolveCreateParent,
	vaultRelativePath,
} from "@/lib/vault";
import { isVaultAgentRoot } from "@/lib/vault/agent-tree";
import { normalizePathKey } from "@/lib/vault/path";
import { openTexPdf } from "@/lib/workspace/actions";
import {
	addFilePathToChat,
	copyFilePath,
	openFilePathInTerminal,
	revealFilePath,
} from "@/lib/workspace/file-path-actions";
import { isTexPath } from "@/lib/workspace/viewer";
import type { TreeContextMenuPortalProps } from "../tree-context-menu";
import { pathKey, VAULT_ROOT_LABEL_KEY, vaultRootFace } from "../tree-helpers";
import type {
	TreeContextMenu,
	TreeCreateDraft,
	TreeCreateKind,
	TreeRenameDraft,
} from "../types";

/** Virtual rows and `agentero:` pseudo paths have no OS location. */
function canRevealPath(path: string): boolean {
	return Boolean(path) && !path.startsWith("agentero:");
}

/**
 * Catalog id for a paper-directory row. Files and plain folders get none,
 * and a paper with no loaded metadata stays undefined.
 */
function paperDirectoryCatalogId(
	isPaperMenu: boolean,
	vaultPath: string | null,
	menuPath: string,
	paperMetaByRelPath: ReadonlyMap<string, PaperMetadata> | undefined,
): string | undefined {
	if (!isPaperMenu || !vaultPath || !paperMetaByRelPath) return undefined;
	const rel = vaultRelativePath(vaultPath, menuPath);
	if (!rel) return undefined;
	const key = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	const id = paperMetaByRelPath.get(key)?.id.trim();
	return id || undefined;
}

export type TreeContextMenuState = {
	/** Non-null while the menu is open — spread onto `TreeContextMenuPortal`. */
	menuProps: TreeContextMenuPortalProps | null;
	/** Reveal / open-in-terminal failure shown under the tree. */
	revealError: string | null;
	handleContextMenuPath: (path: string, event: ReactMouseEvent) => void;
};

export function useTreeContextMenu({
	nodes,
	vaultPath,
	paperMetaByRelPath,
	byPath,
	cutPaths,
	cutPathKeys,
	createDraft,
	renameDraft,
	libraryExportBusy,
	citingScanBusy,
	pathsForAction,
	prepareContextSelection,
	openMovePicker,
	onExportLibrary,
	onDiscoverCiting,
	onDownloadAllMissing,
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
	skillLabels,
}: {
	nodes: FileNode[];
	vaultPath: string | null;
	/** Catalog rows keyed by vault-relative path. Used only for paper-directory ids. */
	paperMetaByRelPath?: ReadonlyMap<string, PaperMetadata>;
	byPath: ReadonlyMap<string, FileNode>;
	cutPaths: string[];
	cutPathKeys: ReadonlySet<string>;
	createDraft: TreeCreateDraft | null;
	renameDraft?: TreeRenameDraft | null;
	libraryExportBusy: boolean;
	citingScanBusy: boolean;
	pathsForAction: (path: string) => string[];
	/** Right-click keeps an existing group, otherwise makes this the sole target. */
	prepareContextSelection: (path: string) => void;
	openMovePicker: (paths: string[], anchor?: { x: number; y: number }) => void;
	onExportLibrary?: () => void | Promise<void>;
	onDiscoverCiting?: () => void | Promise<void>;
	/** Papers root menu: download assets for every incomplete paper. */
	onDownloadAllMissing?: () => void | Promise<void>;
	onEmptyTrash?: () => void | Promise<void>;
	onOpenPaperNotes?: (paperDir: string) => void;
	onEditPaperMeta?: (paperDir: string) => void;
	onStartCreate?: (kind: TreeCreateKind, parentPath: string) => void;
	onStartRename?: (path: string) => void;
	onDeletePath?: (path: string) => void | Promise<void>;
	onDeletePaths?: (paths: string[]) => void | Promise<void>;
	onCutPaths?: (paths: string[]) => void;
	onPasteInto?: (targetPath: string) => void;
	onMoveTo?: (paths: string[], destParentRel: string) => void;
	skillLabels?: ReadonlyMap<string, { name: string }>;
}): TreeContextMenuState {
	const { t } = useTranslation("sidebar");
	const [menu, setMenu] = useState<TreeContextMenu | null>(null);
	const [revealError, setRevealError] = useState<string | null>(null);
	const menuRef = useRef<HTMLDivElement>(null);

	const close = useCallback(() => setMenu(null), []);

	const handleContextMenuPath = useCallback(
		(path: string, event: ReactMouseEvent) => {
			if (createDraft || renameDraft) return;
			// Real vault paths + virtual Recycle Bin (empty) / Plaza root
			// (source visibility toggles).
			if (
				!canRevealPath(path) &&
				path !== TRASH_VIRTUAL_PATH &&
				path !== PLAZA_VIRTUAL_PATH
			) {
				return;
			}
			event.preventDefault();
			event.stopPropagation();
			prepareContextSelection(path);
			setRevealError(null);
			setMenu({ path, x: event.clientX, y: event.clientY });
		},
		[createDraft, renameDraft, prepareContextSelection],
	);

	const reveal = useCallback((path: string) => {
		setMenu(null);
		if (!canRevealPath(path)) return;
		setRevealError(null);
		void revealFilePath(path).catch((error) => {
			setRevealError(errorText(error));
		});
	}, []);

	const openTerminal = useCallback((path: string) => {
		setMenu(null);
		if (!canRevealPath(path)) return;
		setRevealError(null);
		void openFilePathInTerminal(path).catch((error) => {
			setRevealError(errorText(error));
		});
	}, []);

	const copyPath = useCallback((path: string) => {
		setMenu(null);
		copyFilePath(path);
	}, []);

	// Toggle a Plaza source without closing the menu (multi-toggle friendly).
	const togglePlazaSource = useCallback((id: string) => {
		const current = getSettings().plazaHiddenSources;
		patchSettings({
			plazaHiddenSources: current.includes(id)
				? current.filter((s) => s !== id)
				: [...current, id],
		});
	}, []);

	if (!menu) {
		return { menuProps: null, revealError, handleContextMenuPath };
	}

	const targets = pathsForAction(menu.path);
	const menuNode = byPath.get(menu.path);
	const isPaperMenu =
		menuNode?.kind === "directory" &&
		isPaperDirectory(menuNode.path, menuNode.children);
	// The `papers/` root folder carries the library actions.
	const isLibraryMenu =
		menuNode?.kind === "directory" && isPapersRoot(menuNode.path);
	const targetIsVirtual = menu.path === TRASH_VIRTUAL_PATH;
	const targetKey = pathKey(menu.path);
	const canPasteAtTarget =
		cutPaths.length > 0 &&
		!targetIsVirtual &&
		Boolean(menu.path) &&
		!cutPathKeys.has(targetKey) &&
		!cutPaths.some((p) => targetKey.startsWith(`${pathKey(p)}/`));

	const rootFace = menuNode ? vaultRootFace(vaultPath, menuNode.path) : null;
	const skillLabel = skillLabels?.get(normalizePathKey(menu.path))?.name;
	const menuNodeName = isVaultAgentRoot(vaultPath, menu.path)
		? t("fileTree.vaultRoot.agents")
		: (skillLabel ??
			(rootFace ? t(VAULT_ROOT_LABEL_KEY[rootFace]) : menuNode?.name));
	const menuProps: TreeContextMenuPortalProps = {
		menu,
		menuRef,
		vaultPath,
		paperId: paperDirectoryCatalogId(
			isPaperMenu,
			vaultPath,
			menu.path,
			paperMetaByRelPath,
		),
		menuCount: targets.length,
		menuNodeName,
		isPaperMenu,
		isLibraryMenu,
		libraryExportBusy,
		citingScanBusy,
		canPasteAtTarget,
		plazaSources:
			menu.path === PLAZA_VIRTUAL_PATH
				? PLAZA_SOURCES.map((source) => ({
						source,
						hidden: getSettings().plazaHiddenSources.includes(source.id),
					}))
				: undefined,
		onTogglePlazaSource:
			menu.path === PLAZA_VIRTUAL_PATH ? togglePlazaSource : undefined,
		onClose: close,
		onExportLibrary: onExportLibrary
			? () => {
					setMenu(null);
					void onExportLibrary();
				}
			: undefined,
		onDiscoverCiting: onDiscoverCiting
			? () => {
					setMenu(null);
					void onDiscoverCiting();
				}
			: undefined,
		onDownloadAllMissing: onDownloadAllMissing
			? () => {
					setMenu(null);
					void onDownloadAllMissing();
				}
			: undefined,
		onEmptyTrash: onEmptyTrash
			? () => {
					setMenu(null);
					void onEmptyTrash();
				}
			: undefined,
		onOpenNotes: onOpenPaperNotes
			? () => {
					setMenu(null);
					onOpenPaperNotes(menu.path);
				}
			: undefined,
		onOpenTexPdf:
			targets.length === 1 && isTexPath(menu.path)
				? () => {
						setMenu(null);
						void openTexPdf(menu.path);
					}
				: undefined,
		onEditMeta:
			isPaperMenu && onEditPaperMeta
				? () => {
						setMenu(null);
						onEditPaperMeta(menu.path);
					}
				: undefined,
		onAddToChat:
			!targetIsVirtual && menu.path && !menu.path.startsWith("agentero:")
				? () => {
						setMenu(null);
						addFilePathToChat(menu.path);
					}
				: undefined,
		onNewFile:
			onStartCreate && vaultPath
				? () => {
						const parent = resolveCreateParent(vaultPath, menu.path, nodes);
						setMenu(null);
						onStartCreate("file", parent);
					}
				: undefined,
		onNewTable:
			onStartCreate && vaultPath
				? () => {
						const parent = resolveCreateParent(vaultPath, menu.path, nodes);
						setMenu(null);
						onStartCreate("table", parent);
					}
				: undefined,
		onNewFolder:
			onStartCreate && vaultPath
				? () => {
						const parent = resolveCreateParent(vaultPath, menu.path, nodes);
						setMenu(null);
						onStartCreate("folder", parent);
					}
				: undefined,
		onCopyPath: () => copyPath(menu.path),
		onCut:
			onCutPaths && !targetIsVirtual
				? () => {
						setMenu(null);
						onCutPaths(targets);
					}
				: undefined,
		onPaste: onPasteInto
			? () => {
					setMenu(null);
					onPasteInto(menu.path);
				}
			: undefined,
		onReveal: () => reveal(menu.path),
		onOpenInTerminal: () => openTerminal(menu.path),
		onMove: onMoveTo
			? () => {
					const anchor = { x: menu.x, y: menu.y };
					setMenu(null);
					openMovePicker(targets, anchor);
				}
			: undefined,
		onRename: onStartRename
			? () => {
					setMenu(null);
					onStartRename(menu.path);
				}
			: undefined,
		onDelete:
			onDeletePath || onDeletePaths
				? () => {
						setMenu(null);
						if (targets.length > 1 && onDeletePaths)
							void onDeletePaths(targets);
						else if (onDeletePath && targets[0]) void onDeletePath(targets[0]);
					}
				: undefined,
	};

	return { menuProps, revealError, handleContextMenuPath };
}
