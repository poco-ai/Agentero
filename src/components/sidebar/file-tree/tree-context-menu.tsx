import {
	ArrowDownToLine,
	Download,
	Loader2,
	Radar,
	Trash2,
} from "lucide-react";
import { type RefObject, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { ViewportFloating } from "@/components/ui/viewport-floating";
import { cn } from "@/lib/core/utils";
import { TRASH_VIRTUAL_PATH } from "@/lib/paper/api";
import {
	PLAZA_VIRTUAL_PATH,
	type PlazaSource,
	plazaSourceLabel,
} from "@/lib/plaza";
import type { MenuContext } from "@/lib/shell/commands/menu-contributions";
import {
	activateMenuContribution,
	visibleMenuContributions,
} from "@/lib/shell/commands/menu-contributions";
import { formatShortcutById } from "@/lib/shell/shortcuts";
import { vaultRelativePath } from "@/lib/vault";
import { revealInOsLabelKey } from "@/lib/vault/reveal";
import type { TreeContextMenu } from "./types";

function fileTreeItemContext(
	vaultPath: string | null,
	path: string,
	paperId: string | undefined,
): MenuContext {
	const rel = vaultPath ? vaultRelativePath(vaultPath, path) : null;
	return {
		vaultPath,
		...(rel != null ? { relPath: rel } : {}),
		...(paperId ? { paperId } : {}),
	};
}

export type TreeContextMenuPortalProps = {
	menu: TreeContextMenu;
	menuRef: RefObject<HTMLDivElement | null>;
	/** Vault root the tree already has. Null when no vault is open. */
	vaultPath: string | null;
	/**
	 * Catalog id when this row is a paper directory and metadata is loaded.
	 * Omitted for files, folders, and papers with no id.
	 */
	paperId?: string;
	menuCount: number;
	menuNodeName?: string;
	isPaperMenu: boolean;
	/** `papers/` root: prepend the library actions to the folder menu. */
	isLibraryMenu: boolean;
	libraryExportBusy: boolean;
	citingScanBusy: boolean;
	canPasteAtTarget: boolean;
	/** Plaza root menu: every source with its current hidden state. */
	plazaSources?: { source: PlazaSource; hidden: boolean }[];
	/** Toggle one Plaza source; menu stays open for multi-toggle. */
	onTogglePlazaSource?: (id: string) => void;
	onClose: () => void;
	/** Each callback is optional — `undefined` hides the matching menu item. */
	onExportLibrary?: () => void;
	/** Scan the whole library for new papers citing it. */
	onDiscoverCiting?: () => void;
	/** Download assets for every incomplete paper in the library. */
	onDownloadAllMissing?: () => void;
	onEmptyTrash?: () => void;
	onOpenNotes?: () => void;
	/** .tex row: open (or compile then open) the compiled PDF beside it. */
	onOpenTexPdf?: () => void;
	/** Paper row: open the catalog metadata editor. */
	onEditMeta?: () => void;
	/** Add the right-clicked file/paper to the Agent chat as a context chip. */
	onAddToChat?: () => void;
	onNewFile?: () => void;
	onNewTable?: () => void;
	onNewFolder?: () => void;
	onCopyPath?: () => void;
	onCut?: () => void;
	onPaste?: () => void;
	onReveal?: () => void;
	onOpenInTerminal?: () => void;
	onMove?: () => void;
	onRename?: () => void;
	onDelete?: () => void;
};

export function TreeContextMenuPortal({
	menu,
	menuRef,
	vaultPath,
	paperId,
	menuCount,
	menuNodeName,
	isPaperMenu,
	isLibraryMenu,
	libraryExportBusy,
	citingScanBusy,
	canPasteAtTarget,
	plazaSources,
	onTogglePlazaSource,
	onClose,
	onExportLibrary,
	onDiscoverCiting,
	onDownloadAllMissing,
	onEmptyTrash,
	onOpenNotes,
	onOpenTexPdf,
	onEditMeta,
	onAddToChat,
	onNewFile,
	onNewTable,
	onNewFolder,
	onCopyPath,
	onCut,
	onPaste,
	onReveal,
	onOpenInTerminal,
	onMove,
	onRename,
	onDelete,
}: TreeContextMenuPortalProps) {
	const { t } = useTranslation("sidebar");

	// Re-register only when the menu opens/changes (matches original deps).
	// biome-ignore lint/correctness/useExhaustiveDependencies: intentional
	useEffect(() => {
		const close = () => onClose();
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") close();
		};
		const onPointer = (e: PointerEvent) => {
			const el = menuRef.current;
			if (el && e.target instanceof Node && el.contains(e.target)) return;
			close();
		};
		// Defer so the opening contextmenu event does not immediately close.
		const timer = window.setTimeout(() => {
			window.addEventListener("pointerdown", onPointer, true);
			window.addEventListener("keydown", onKey, true);
			window.addEventListener("scroll", close, true);
			window.addEventListener("resize", close);
		}, 0);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener("pointerdown", onPointer, true);
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("scroll", close, true);
			window.removeEventListener("resize", close);
		};
	}, [menu]);

	const isTrashMenu = menu.path === TRASH_VIRTUAL_PATH;
	const isPlazaMenu = menu.path === PLAZA_VIRTUAL_PATH;
	// Recycle / Plaza roots are different menus. Contributions attach only to
	// the item menu that already has path-based actions.
	const isItemMenu = !isTrashMenu && !isPlazaMenu;
	const itemContributions = isItemMenu
		? visibleMenuContributions(
				"fileTree.item",
				fileTreeItemContext(
					vaultPath,
					menu.path,
					isPaperMenu ? paperId : undefined,
				),
			)
		: [];

	const revealLabel = t(revealInOsLabelKey());
	const revealShortcut = formatShortcutById("revealInFinder");
	const openInTerminalShortcut = formatShortcutById("openInTerminal");
	const splitPaneShortcut = formatShortcutById("splitPane");
	const deleteShortcut = formatShortcutById("deleteTreeItem");
	const cutShortcut = formatShortcutById("cutTreeItem");
	const pasteShortcut = formatShortcutById("pasteTreeItem");

	return (
		<ViewportFloating
			floatingRef={menuRef}
			point={{ x: menu.x, y: menu.y }}
			role="menu"
			className="z-50 min-w-44 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10"
		>
			{isLibraryMenu ? (
				<>
					{onDownloadAllMissing ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
							onClick={onDownloadAllMissing}
						>
							<ArrowDownToLine className="size-3.5 shrink-0" aria-hidden />
							<span>{t("fileTree.downloadAllMissing")}</span>
						</button>
					) : null}
					{onExportLibrary ? (
						<button
							type="button"
							role="menuitem"
							disabled={libraryExportBusy}
							className="flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
							onClick={onExportLibrary}
						>
							{libraryExportBusy ? (
								<Loader2
									className="size-3.5 shrink-0 animate-spin"
									aria-hidden
								/>
							) : (
								<Download className="size-3.5 shrink-0" aria-hidden />
							)}
							<span>
								{libraryExportBusy
									? t("papersLibrary.exporting")
									: t("papersLibrary.export")}
							</span>
						</button>
					) : null}
					{onDiscoverCiting ? (
						<button
							type="button"
							role="menuitem"
							disabled={citingScanBusy}
							className="flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground disabled:pointer-events-none disabled:opacity-50"
							onClick={onDiscoverCiting}
						>
							{citingScanBusy ? (
								<Loader2
									className="size-3.5 shrink-0 animate-spin"
									aria-hidden
								/>
							) : (
								<Radar className="size-3.5 shrink-0" aria-hidden />
							)}
							<span>
								{citingScanBusy
									? t("papersLibrary.discoveringCiting")
									: t("papersLibrary.discoverCiting")}
							</span>
						</button>
					) : null}
				</>
			) : null}
			{isTrashMenu ? (
				onEmptyTrash ? (
					<button
						type="button"
						role="menuitem"
						className="flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm text-destructive outline-hidden select-none hover:bg-destructive/10 focus:bg-destructive/10"
						onClick={onEmptyTrash}
					>
						<Trash2 className="size-3.5 shrink-0" aria-hidden />
						<span>{t("recycleBin.emptyTrash")}</span>
					</button>
				) : null
			) : isPlazaMenu && plazaSources ? (
				plazaSources.map(({ source, hidden }) => (
					<button
						key={source.id}
						type="button"
						role="menuitemcheckbox"
						aria-checked={!hidden}
						className="flex w-full cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
						onClick={() => onTogglePlazaSource?.(source.id)}
					>
						<span
							className={cn(
								"flex size-3.5 shrink-0 items-center justify-center rounded-sm border",
								hidden
									? "border-muted-foreground/40"
									: "border-primary bg-primary text-primary-foreground",
							)}
							aria-hidden
						>
							{hidden ? null : (
								<span className="text-caption leading-none">✓</span>
							)}
						</span>
						<span>{plazaSourceLabel(source)}</span>
					</button>
				))
			) : (
				<>
					{menuCount === 1 && isPaperMenu && onOpenNotes ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center justify-between gap-4 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
							onClick={onOpenNotes}
						>
							<span>{t("fileTree.openNotes")}</span>
							<span className="text-muted-foreground text-xs tracking-wide">
								{splitPaneShortcut}
							</span>
						</button>
					) : null}
					{menuCount === 1 && onOpenTexPdf ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center justify-between gap-4 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
							onClick={onOpenTexPdf}
						>
							<span>{t("fileTree.openTexPdf")}</span>
							<span className="text-muted-foreground text-xs tracking-wide">
								{splitPaneShortcut}
							</span>
						</button>
					) : null}
					{menuCount === 1 && isPaperMenu && onEditMeta ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center gap-4 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
							onClick={onEditMeta}
						>
							<span>{t("papersLibrary.rowEditMeta")}</span>
						</button>
					) : null}
					{menuCount === 1 && onAddToChat ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center gap-4 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
							onClick={onAddToChat}
						>
							<span>{t("fileTree.addToChat")}</span>
						</button>
					) : null}
					{menuCount === 1 && onNewTable ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center gap-4 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
							onClick={onNewTable}
						>
							{t("newTableLabel")}
						</button>
					) : null}
					{menuCount === 1 && onNewFile ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center gap-4 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
							onClick={onNewFile}
						>
							<span>{t("fileTree.newFile")}</span>
						</button>
					) : null}
					{menuCount === 1 && onNewFolder && !isPaperMenu ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center gap-4 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
							onClick={onNewFolder}
						>
							<span>{t("fileTree.newFolder")}</span>
						</button>
					) : null}
					{menuCount === 1 && onCopyPath ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center gap-4 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
							onClick={onCopyPath}
						>
							<span>{t("fileTree.copyPath")}</span>
						</button>
					) : null}
					{onCut ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center justify-between gap-4 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
							onClick={onCut}
						>
							<span>
								{menuCount > 1
									? t("fileTree.cutSelected", { count: menuCount })
									: t("fileTree.cut")}
							</span>
							<span className="text-muted-foreground text-xs tracking-wide">
								{cutShortcut}
							</span>
						</button>
					) : null}
					{canPasteAtTarget && onPaste ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center justify-between gap-4 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
							onClick={onPaste}
						>
							<span>
								{menuCount > 1 || isPaperMenu
									? t("fileTree.paste")
									: t("fileTree.pasteInto", {
											name: menuNodeName ?? t("fileTree.paste"),
										})}
							</span>
							<span className="text-muted-foreground text-xs tracking-wide">
								{pasteShortcut}
							</span>
						</button>
					) : null}
					{menuCount === 1 && onReveal ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center justify-between gap-4 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
							onClick={onReveal}
						>
							<span>{revealLabel}</span>
							<span className="text-muted-foreground text-xs tracking-wide">
								{revealShortcut}
							</span>
						</button>
					) : null}
					{menuCount === 1 && onOpenInTerminal ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center justify-between gap-4 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
							onClick={onOpenInTerminal}
						>
							<span>{t("fileTree.openInTerminal")}</span>
							<span className="text-muted-foreground text-xs tracking-wide">
								{openInTerminalShortcut}
							</span>
						</button>
					) : null}
					{onMove ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center gap-4 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
							onClick={onMove}
						>
							<span>
								{menuCount > 1
									? t("fileTree.moveSelected", { count: menuCount })
									: t("fileTree.move")}
							</span>
						</button>
					) : null}
					{menuCount === 1 && onRename ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center gap-4 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
							onClick={onRename}
						>
							<span>{t("fileTree.rename")}</span>
						</button>
					) : null}
					{onDelete ? (
						<button
							type="button"
							role="menuitem"
							className="flex w-full cursor-default items-center justify-between gap-4 rounded-md px-2 py-1.5 text-left text-sm text-destructive outline-hidden select-none hover:bg-destructive/10 focus:bg-destructive/10"
							onClick={onDelete}
						>
							<span>
								{menuCount > 1
									? t("fileTree.deleteSelected", { count: menuCount })
									: t("fileTree.delete")}
							</span>
							{menuCount === 1 ? (
								<span className="text-xs tracking-wide opacity-80">
									{deleteShortcut}
								</span>
							) : null}
						</button>
					) : null}
					{itemContributions.length > 0 ? (
						<>
							<div className="-mx-1 my-1 h-px bg-border" />
							{itemContributions.map((item) => (
								<button
									key={item.id}
									type="button"
									role="menuitem"
									className="flex w-full cursor-default items-center gap-4 rounded-md px-2 py-1.5 text-left text-sm outline-hidden select-none hover:bg-accent hover:text-accent-foreground focus:bg-accent focus:text-accent-foreground"
									onClick={() => {
										onClose();
										activateMenuContribution(
											item,
											fileTreeItemContext(
												vaultPath,
												menu.path,
												isPaperMenu ? paperId : undefined,
											),
										);
									}}
								>
									<span>{item.title}</span>
								</button>
							))}
						</>
					) : null}
				</>
			)}
		</ViewportFloating>
	);
}
