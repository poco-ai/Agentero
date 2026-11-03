/**
 * Files of the open manuscript. Build artifacts stay hidden.
 * Right-click opens the same actions for every row.
 */

import { open, save } from "@tauri-apps/plugin-dialog";
import { readFile, writeFile } from "@tauri-apps/plugin-fs";
import { FileText, Folder, FolderOpen } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
	FILE_TREE_ROW_SELECTED_STATE,
	FILE_TREE_ROW_STATE,
	FileTreeDisclosureIcon,
} from "@/components/sidebar/file-tree/file-tree-primitives";
import { Button } from "@/components/ui/button";
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	useWritingPathItems,
	WritingMenuContent,
	type WritingMenuItem,
} from "@/components/writing/writing-menu";
import { WritingMoveDialog } from "@/components/writing/writing-move-dialog";
import { useVaultStore } from "@/hooks/use-app-stores";
import { errorText } from "@/lib/core/error";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { basenameOf, normalizePath } from "@/lib/core/path";
import { cn } from "@/lib/core/utils";
import { formatShortcutById } from "@/lib/shell/shortcuts";
import {
	explicitTexRoot,
	setDirectoryTexRoot,
	texSettingsStore,
} from "@/lib/tex/config";
import {
	createVaultDirectory,
	type FileNode,
	isValidVaultEntryName,
	joinVaultPath,
	listVaultDirChildren,
	readVaultBytes,
	removeVaultPath,
	vaultPathExists,
	vaultRelativePath,
	writeVaultBytes,
	writeVaultFile,
} from "@/lib/vault";
import { cutSelectedPaths, pasteCutPaths } from "@/lib/vault/actions";
import { normalizePathKey } from "@/lib/vault/path";
import { refreshTree } from "@/lib/vault/store";
import { moveVaultPath } from "@/lib/wiki";
import { syncMovedPaths } from "@/lib/wiki/actions";
import { dirtyVaultPaths } from "@/lib/workspace/persistence";
import {
	compareWritingNodes,
	isWritingSourceName,
	withoutNestedProjects,
} from "@/lib/writing/files";
import {
	closeWritingFile,
	setWritingFile,
	writingStore,
} from "@/lib/writing/store";
import { applyWritingMoves } from "@/lib/writing/tree-actions";
import {
	clearWritingTreeDelete,
	forgetWritingTreeTargets,
	setWritingTreeTarget,
	type WritingTreeTarget,
	writingTreeStore,
} from "@/lib/writing/tree-target";

function visibleNodes(nodes: readonly FileNode[]): FileNode[] {
	return nodes
		.filter((node) => isWritingSourceName(node.kind, node.name))
		.sort(compareWritingNodes);
}

function withLeadingSeparator(
	items: readonly WritingMenuItem[],
): WritingMenuItem[] {
	return items.map((item, index) =>
		index === 0 ? { ...item, separatorBefore: true } : item,
	);
}

type NameAsk = {
	title: string;
	initial: string;
	submit: (name: string) => Promise<void>;
};

export function ManuscriptFiles({
	vaultPath,
	rootDir,
	activePath,
	projectDirs,
	projectRoot,
}: {
	vaultPath: string;
	rootDir: string;
	activePath: string | null;
	/** Directories of other projects. They are not chapters of this one. */
	projectDirs: ReadonlySet<string>;
	projectRoot: string;
}) {
	const { t } = useTranslation("sidebar");
	const [nodes, setNodes] = useState<FileNode[] | null>(null);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const [childNodes, setChildNodes] = useState<Record<string, FileNode[]>>({});
	const [revision, setRevision] = useState(0);
	const [ask, setAsk] = useState<NameAsk | null>(null);
	const [pendingDelete, setPendingDelete] = useState<WritingTreeTarget | null>(
		null,
	);
	const [pendingMove, setPendingMove] = useState<FileNode | null>(null);
	const roots = useStore(texSettingsStore, (state) => state.roots);
	const cutPaths = useVaultStore((state) => state.cutPaths);
	const treeRevision = useStore(writingTreeStore, (state) => state.revision);
	const deleteRequest = useStore(
		writingTreeStore,
		(state) => state.deleteRequest,
	);
	const cutPathKeys = useMemo(
		() => new Set(cutPaths.map((path) => normalizePathKey(path))),
		[cutPaths],
	);
	const rootPathItems = useWritingPathItems(rootDir);
	const mainPath =
		roots[normalizePath(rootDir)] ?? explicitTexRoot(rootDir) ?? projectRoot;

	useEffect(() => {
		const request = revision;
		let cancelled = false;
		setNodes(null);
		void listVaultDirChildren(vaultPath, rootDir)
			.then((listed) => {
				if (!cancelled && request === revision) setNodes(visibleNodes(listed));
			})
			.catch(() => {
				if (!cancelled && request === revision) setNodes([]);
			});
		return () => {
			cancelled = true;
		};
	}, [vaultPath, rootDir, revision]);

	useEffect(() => {
		if (!deleteRequest) return;
		clearWritingTreeDelete();
		setPendingDelete(deleteRequest);
	}, [deleteRequest]);

	useEffect(() => {
		if (treeRevision === 0) return;
		setChildNodes({});
		setRevision((current) => current + 1);
	}, [treeRevision]);

	const reload = () => {
		setChildNodes({});
		setRevision((current) => current + 1);
	};

	const applyMovedPaths = (moved: readonly { from: string; to: string }[]) => {
		if (moved.length === 0) return;
		applyWritingMoves(moved);
		reload();
	};

	const canPasteInto = (dir: string): boolean => {
		if (cutPaths.length === 0) return false;
		const key = normalizePathKey(dir);
		return (
			!cutPathKeys.has(key) &&
			!cutPaths.some((path) => key.startsWith(`${normalizePathKey(path)}/`))
		);
	};

	const toggleDirectory = (node: FileNode) => {
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(node.path)) next.delete(node.path);
			else next.add(node.path);
			return next;
		});
		if (childNodes[node.path]) return;
		void listVaultDirChildren(vaultPath, node.path)
			.then((listed) => {
				setChildNodes((current) => ({
					...current,
					[node.path]: visibleNodes(listed),
				}));
			})
			.catch(() => {
				setChildNodes((current) => ({ ...current, [node.path]: [] }));
			});
	};

	async function createEntry(dir: string, name: string, directory: boolean) {
		const trimmed = name.trim();
		const fileName =
			directory || trimmed.includes(".") ? trimmed : `${trimmed}.tex`;
		if (!isValidVaultEntryName(fileName)) {
			notifyError(t("fileTree.invalidName"));
			return;
		}
		const target = joinVaultPath(dir, fileName);
		if (await vaultPathExists(target)) {
			notifyError(t("fileTree.alreadyExists", { name: fileName }));
			return;
		}
		if (directory) await createVaultDirectory(target);
		else {
			await writeVaultFile(target, "");
			setWritingFile(target);
		}
		reload();
	}

	async function moveNodeTo(node: FileNode, target: string) {
		const from = vaultRelativePath(vaultPath, node.path);
		const to = vaultRelativePath(vaultPath, target);
		if (!from || !to) return;
		const result = await moveVaultPath(
			vaultPath,
			from,
			to,
			dirtyVaultPaths(vaultPath),
		);
		syncMovedPaths(vaultPath, node.path, target, from, to, result);
		applyWritingMoves([{ from: node.path, to: target }]);
		await refreshTree(vaultPath);
		reload();
	}

	async function renameFile(node: FileNode, name: string) {
		const trimmed = name.trim();
		if (!isValidVaultEntryName(trimmed)) {
			notifyError(t("fileTree.invalidName"));
			return;
		}
		const parent = node.path.slice(0, node.path.length - node.name.length);
		const target = joinVaultPath(parent.replace(/[\\/]$/, ""), trimmed);
		if (await vaultPathExists(target)) {
			notifyError(t("fileTree.alreadyExists", { name: trimmed }));
			return;
		}
		await moveNodeTo(node, target);
	}

	async function moveFile(node: FileNode, destDir: string) {
		const target = joinVaultPath(destDir, node.name);
		if (normalizePath(target) === normalizePath(node.path)) {
			setPendingMove(null);
			return;
		}
		if (await vaultPathExists(target)) {
			notifyError(t("fileTree.alreadyExists", { name: node.name }));
			return;
		}
		await moveNodeTo(node, target);
		setPendingMove(null);
	}

	async function downloadFile(node: FileNode) {
		const dest = await save({ defaultPath: node.name });
		if (!dest) return;
		await writeFile(dest, await readVaultBytes(node.path));
	}

	async function uploadInto(dir: string) {
		const picked = await open({ multiple: true });
		if (!picked) return;
		const paths = Array.isArray(picked) ? picked : [picked];
		for (const source of paths) {
			const name = basenameOf(source);
			if (!isValidVaultEntryName(name)) continue;
			const target = joinVaultPath(dir, name);
			if (await vaultPathExists(target)) {
				notifyError(t("fileTree.alreadyExists", { name }));
				continue;
			}
			await writeVaultBytes(target, await readFile(source));
		}
		reload();
	}

	function makeMain(node: FileNode) {
		setDirectoryTexRoot(rootDir, node.path);
		notifySuccess(t("writing.setMainFileDone"));
	}

	async function deleteFile(node: WritingTreeTarget) {
		await removeVaultPath(node.path);
		const key = normalizePath(node.path).toLowerCase();
		for (const file of writingStore.getState().openFiles) {
			const current = normalizePath(file).toLowerCase();
			if (current === key || current.startsWith(`${key}/`)) {
				closeWritingFile(file);
			}
		}
		forgetWritingTreeTargets(node.path);
		setPendingDelete(null);
		reload();
	}

	if (nodes == null) {
		return (
			<p className="text-muted-foreground px-2 py-2 text-xs">
				{t("writing.loadingFiles")}
			</p>
		);
	}
	const shown = withoutNestedProjects(nodes, projectDirs);
	const rootItems: WritingMenuItem[] = [
		{
			id: "new-file",
			label: t("fileTree.newFile"),
			run: () =>
				setAsk({
					title: t("fileTree.newFile"),
					initial: "",
					submit: (name) => createEntry(rootDir, name, false),
				}),
		},
		{
			id: "new-folder",
			label: t("fileTree.newFolder"),
			run: () =>
				setAsk({
					title: t("fileTree.newFolder"),
					initial: "",
					submit: (name) => createEntry(rootDir, name, true),
				}),
		},
		{
			id: "upload",
			label: t("writing.upload"),
			run: () => void uploadInto(rootDir).catch(fail),
		},
		...(canPasteInto(rootDir)
			? [
					{
						id: "paste",
						label: t("fileTree.paste"),
						shortcut: formatShortcutById("pasteTreeItem"),
						separatorBefore: true,
						run: () => void pasteInto(rootDir).catch(fail),
					},
				]
			: []),
		...withLeadingSeparator(rootPathItems),
	];

	async function pasteInto(dir: string) {
		const moved = await pasteCutPaths(dir);
		applyMovedPaths(moved);
	}

	return (
		<>
			<ContextMenu>
				<ContextMenuTrigger asChild>
					{/* biome-ignore lint/a11y/noStaticElementInteractions: right-click selects the project root for shortcuts */}
					<div
						data-file-tree=""
						className="min-h-0 flex-1 overflow-y-auto px-1 pt-1 pb-1"
						onContextMenu={(event) => {
							if (
								event.target instanceof Element &&
								event.target.closest("button")
							) {
								return;
							}
							setWritingTreeTarget({
								path: rootDir,
								name: basenameOf(rootDir),
								kind: "directory",
							});
						}}
					>
						{shown.length === 0 ? (
							<p className="text-muted-foreground px-2 py-2 text-xs">
								{t("writing.noSources")}
							</p>
						) : (
							<NodeList
								nodes={shown}
								depth={0}
								activePath={activePath}
								expanded={expanded}
								childNodes={childNodes}
								projectDirs={projectDirs}
								loadingLabel={t("writing.loadingFiles")}
								mainPath={mainPath}
								cutPathKeys={cutPathKeys}
								canPasteInto={canPasteInto}
								onMakeMain={makeMain}
								onToggle={toggleDirectory}
								onNewFile={(dir) =>
									setAsk({
										title: t("fileTree.newFile"),
										initial: "",
										submit: (name) => createEntry(dir, name, false),
									})
								}
								onNewFolder={(dir) =>
									setAsk({
										title: t("fileTree.newFolder"),
										initial: "",
										submit: (name) => createEntry(dir, name, true),
									})
								}
								onUpload={(dir) => void uploadInto(dir).catch(fail)}
								onCut={(node) => cutSelectedPaths([node.path])}
								onPaste={(dir) => void pasteInto(dir).catch(fail)}
								onMove={setPendingMove}
								onRename={(node) =>
									setAsk({
										title: t("fileTree.rename"),
										initial: node.name,
										submit: (name) => renameFile(node, name),
									})
								}
								onDownload={(node) => void downloadFile(node).catch(fail)}
								onDelete={setPendingDelete}
							/>
						)}
					</div>
				</ContextMenuTrigger>
				<WritingMenuContent items={rootItems} />
			</ContextMenu>
			<NameDialog ask={ask} onClose={() => setAsk(null)} />
			<WritingMoveDialog
				open={pendingMove != null}
				vaultPath={vaultPath}
				rootDir={rootDir}
				projectDirs={projectDirs}
				node={pendingMove}
				onClose={() => setPendingMove(null)}
				onMove={(destination) => {
					if (!pendingMove) return;
					void moveFile(pendingMove, destination).catch(fail);
				}}
			/>
			<Dialog
				open={pendingDelete != null}
				onOpenChange={(next) => {
					if (!next) setPendingDelete(null);
				}}
			>
				<DialogContent className="sm:max-w-sm">
					<DialogTitle>{t("writing.deleteFile")}</DialogTitle>
					<p className="text-sm">
						{t("writing.deleteFileConfirm", {
							name: pendingDelete?.name ?? "",
						})}
					</p>
					<DialogFooter>
						<Button
							type="button"
							variant="destructive"
							onClick={() => {
								if (pendingDelete) void deleteFile(pendingDelete).catch(fail);
							}}
						>
							{t("writing.deleteFile")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}

function fail(error: unknown) {
	notifyError(errorText(error));
}

function NodeList({
	nodes,
	depth,
	activePath,
	expanded,
	childNodes,
	projectDirs,
	loadingLabel,
	mainPath,
	cutPathKeys,
	canPasteInto,
	onMakeMain,
	onToggle,
	onNewFile,
	onNewFolder,
	onUpload,
	onCut,
	onPaste,
	onMove,
	onRename,
	onDownload,
	onDelete,
}: {
	nodes: readonly FileNode[];
	depth: number;
	activePath: string | null;
	expanded: ReadonlySet<string>;
	childNodes: Record<string, FileNode[]>;
	projectDirs: ReadonlySet<string>;
	loadingLabel: string;
	mainPath: string;
	cutPathKeys: ReadonlySet<string>;
	canPasteInto: (dir: string) => boolean;
	onMakeMain: (node: FileNode) => void;
	onToggle: (node: FileNode) => void;
	onNewFile: (dir: string) => void;
	onNewFolder: (dir: string) => void;
	onUpload: (dir: string) => void;
	onCut: (node: FileNode) => void;
	onPaste: (dir: string) => void;
	onMove: (node: FileNode) => void;
	onRename: (node: FileNode) => void;
	onDownload: (node: FileNode) => void;
	onDelete: (node: FileNode) => void;
}) {
	return (
		<ul className="flex flex-col">
			{nodes.map((node) => (
				<li key={node.path}>
					<FileRow
						node={node}
						depth={depth}
						selected={
							activePath != null &&
							normalizePath(activePath) === normalizePath(node.path)
						}
						expanded={expanded.has(node.path)}
						mainPath={mainPath}
						cut={cutPathKeys.has(normalizePathKey(node.path))}
						canPaste={canPasteInto(node.path)}
						onMakeMain={onMakeMain}
						onToggle={onToggle}
						onNewFile={onNewFile}
						onNewFolder={onNewFolder}
						onUpload={onUpload}
						onCut={onCut}
						onPaste={onPaste}
						onMove={onMove}
						onRename={onRename}
						onDownload={onDownload}
						onDelete={onDelete}
					/>
					{node.kind === "directory" && expanded.has(node.path) ? (
						childNodes[node.path] ? (
							<NodeList
								nodes={withoutNestedProjects(
									childNodes[node.path],
									projectDirs,
								)}
								depth={depth + 1}
								activePath={activePath}
								expanded={expanded}
								childNodes={childNodes}
								projectDirs={projectDirs}
								loadingLabel={loadingLabel}
								mainPath={mainPath}
								cutPathKeys={cutPathKeys}
								canPasteInto={canPasteInto}
								onMakeMain={onMakeMain}
								onToggle={onToggle}
								onNewFile={onNewFile}
								onNewFolder={onNewFolder}
								onUpload={onUpload}
								onCut={onCut}
								onPaste={onPaste}
								onMove={onMove}
								onRename={onRename}
								onDownload={onDownload}
								onDelete={onDelete}
							/>
						) : (
							<p
								className="text-muted-foreground py-1 text-xs"
								style={{ paddingLeft: 28 + depth * 12 }}
							>
								{loadingLabel}
							</p>
						)
					) : null}
				</li>
			))}
		</ul>
	);
}

function FileRow({
	node,
	depth,
	selected,
	expanded,
	mainPath,
	cut,
	canPaste,
	onMakeMain,
	onToggle,
	onNewFile,
	onNewFolder,
	onUpload,
	onCut,
	onPaste,
	onMove,
	onRename,
	onDownload,
	onDelete,
}: {
	node: FileNode;
	depth: number;
	selected: boolean;
	expanded: boolean;
	mainPath: string;
	cut: boolean;
	canPaste: boolean;
	onMakeMain: (node: FileNode) => void;
	onToggle: (node: FileNode) => void;
	onNewFile: (dir: string) => void;
	onNewFolder: (dir: string) => void;
	onUpload: (dir: string) => void;
	onCut: (node: FileNode) => void;
	onPaste: (dir: string) => void;
	onMove: (node: FileNode) => void;
	onRename: (node: FileNode) => void;
	onDownload: (node: FileNode) => void;
	onDelete: (node: FileNode) => void;
}) {
	const { t } = useTranslation("sidebar");
	const pathItems = useWritingPathItems(node.path);
	const directory = node.kind === "directory";
	const texFile = !directory && node.name.toLowerCase().endsWith(".tex");
	const isMain =
		texFile && normalizePath(node.path) === normalizePath(mainPath);
	const markTarget = () =>
		setWritingTreeTarget({
			path: node.path,
			name: node.name,
			kind: node.kind,
		});
	const items: WritingMenuItem[] = directory
		? [
				{
					id: "new-file",
					label: t("fileTree.newFile"),
					run: () => onNewFile(node.path),
				},
				{
					id: "new-folder",
					label: t("fileTree.newFolder"),
					run: () => onNewFolder(node.path),
				},
				{
					id: "upload",
					label: t("writing.upload"),
					run: () => onUpload(node.path),
				},
				{
					id: "cut",
					label: t("fileTree.cut"),
					shortcut: formatShortcutById("cutTreeItem"),
					separatorBefore: true,
					run: () => onCut(node),
				},
				...(canPaste
					? [
							{
								id: "paste",
								label: t("fileTree.pasteInto", { name: node.name }),
								shortcut: formatShortcutById("pasteTreeItem"),
								run: () => onPaste(node.path),
							},
						]
					: []),
				{
					id: "move",
					label: t("fileTree.move"),
					run: () => onMove(node),
				},
				...withLeadingSeparator(pathItems),
				{
					id: "rename",
					label: t("fileTree.rename"),
					separatorBefore: true,
					run: () => onRename(node),
				},
				{
					id: "delete",
					label: t("writing.deleteFile"),
					shortcut: formatShortcutById("deleteTreeItem"),
					destructive: true,
					separatorBefore: true,
					run: () => onDelete(node),
				},
			]
		: [
				...(texFile
					? [
							{
								id: "main",
								label: isMain
									? t("writing.mainFile")
									: t("writing.setMainFile"),
								disabled: isMain,
								run: () => onMakeMain(node),
							},
						]
					: []),
				{
					id: "rename",
					label: t("fileTree.rename"),
					separatorBefore: texFile,
					run: () => onRename(node),
				},
				{
					id: "download",
					label: t("writing.download"),
					run: () => onDownload(node),
				},
				{
					id: "cut",
					label: t("fileTree.cut"),
					shortcut: formatShortcutById("cutTreeItem"),
					separatorBefore: true,
					run: () => onCut(node),
				},
				{
					id: "move",
					label: t("fileTree.move"),
					run: () => onMove(node),
				},
				...withLeadingSeparator(pathItems),
				{
					id: "delete",
					label: t("writing.deleteFile"),
					shortcut: formatShortcutById("deleteTreeItem"),
					destructive: true,
					separatorBefore: true,
					run: () => onDelete(node),
				},
			];
	return (
		<ContextMenu>
			<ContextMenuTrigger asChild>
				<button
					type="button"
					aria-expanded={directory ? expanded : undefined}
					aria-current={selected ? "page" : undefined}
					title={node.name}
					onContextMenu={() => {
						markTarget();
						if (!directory) setWritingFile(node.path);
					}}
					onFocus={markTarget}
					onClick={() => {
						markTarget();
						if (directory) onToggle(node);
						else setWritingFile(node.path);
					}}
					className={cn(
						"group flex h-7 w-full min-w-0 items-center gap-1 rounded pr-4 text-left text-sm",
						FILE_TREE_ROW_STATE,
						selected && FILE_TREE_ROW_SELECTED_STATE,
						cut && "opacity-50",
					)}
					style={{ paddingLeft: 16 + depth * 12 }}
				>
					{directory ? (
						<FileTreeDisclosureIcon
							isExpanded={expanded}
							icon={
								expanded ? (
									<FolderOpen className="size-4 text-blue-500" aria-hidden />
								) : (
									<Folder className="size-4 text-blue-500" aria-hidden />
								)
							}
						/>
					) : (
						<FileText
							className="size-4 shrink-0 text-muted-foreground"
							aria-hidden
						/>
					)}
					<span className="min-w-0 flex-1 truncate">{node.name}</span>
				</button>
			</ContextMenuTrigger>
			<WritingMenuContent items={items} />
		</ContextMenu>
	);
}

function NameDialog({
	ask,
	onClose,
}: {
	ask: NameAsk | null;
	onClose: () => void;
}) {
	const [value, setValue] = useState("");
	useEffect(() => {
		setValue(ask?.initial ?? "");
	}, [ask]);
	return (
		<Dialog open={ask != null} onOpenChange={(next) => !next && onClose()}>
			<DialogContent className="sm:max-w-sm">
				<DialogTitle>{ask?.title}</DialogTitle>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (!ask) return;
						void ask.submit(value).then(onClose).catch(fail);
					}}
				>
					<Input
						value={value}
						autoFocus
						onChange={(event) => setValue(event.target.value)}
					/>
					<DialogFooter className="mt-3 px-0">
						<Button type="submit">{ask?.title}</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
