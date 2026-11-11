"use client";

import {
	ChevronRightIcon,
	FileIcon,
	FolderIcon,
	FolderOpenIcon,
} from "lucide-react";
import type {
	CSSProperties,
	DragEvent,
	HTMLAttributes,
	KeyboardEvent,
	MouseEvent,
	ReactNode,
} from "react";
import {
	createContext,
	useCallback,
	useContext,
	useMemo,
	useState,
} from "react";
import { TREE_ROW_TEXT_STATE } from "@/components/sidebar/tree-row-styles";
import { cn } from "@/lib/core/utils";

export type SelectMods = { meta: boolean; ctrl: boolean; shift: boolean };

/** Content inset shared by every row: base padding plus one step per level. */
export const TREE_ROW_INSET_PX = 10;
export const TREE_ROW_INDENT_STEP_PX = 12;

interface FileTreeContextType {
	expandedPaths: Set<string>;
	togglePath: (path: string) => void;
	selectedPath?: string;
	onSelect?: (path: string) => void;
	onDoubleClickPath?: (path: string) => void;
	onContextMenuPath?: (path: string, event: MouseEvent) => void;
	/**
	 * Enter starts renaming this row. Returns `false` for rows without a
	 * rename target (virtual nodes), which keeps Enter as row activation.
	 */
	onRenamePath?: (path: string) => boolean;
	/** Multi-selection set (row highlight). No checkboxes — modifier-click only. */
	selectedPaths?: Set<string>;
	/** Row click carrying modifier keys (files + modifier-clicked folders). */
	onSelectRow?: (path: string, mods: SelectMods) => void;
	/** Keyboard cursor row: styled like hover, independent from selection. */
	cursorPath?: string | null;
	setCursorPath: (path: string | null) => void;
	/** Drag-and-drop to move: current drop-target row (highlight) + callbacks. */
	dropTargetPath?: string | null;
	onRowDragStart?: (path: string, e: DragEvent) => void;
	onRowDragOver?: (path: string, e: DragEvent) => void;
	onRowDrop?: (path: string, e: DragEvent) => void;
	onRowDragEnd?: () => void;
}

const noop = () => {};

const FileTreeContext = createContext<FileTreeContextType>({
	expandedPaths: new Set(),
	togglePath: noop,
	cursorPath: null,
	setCursorPath: noop,
});

export function useFileTree(): FileTreeContextType {
	return useContext(FileTreeContext);
}

export type FileTreeProps = Omit<HTMLAttributes<HTMLDivElement>, "onSelect"> & {
	expanded?: Set<string>;
	defaultExpanded?: Set<string>;
	selectedPath?: string;
	onSelect?: (path: string) => void;
	/** Double-click a tree row (file or folder). */
	onDoubleClickPath?: (path: string) => void;
	/** Right-click a tree row (file or folder). */
	onContextMenuPath?: (path: string, event: MouseEvent) => void;
	onRenamePath?: (path: string) => boolean;
	onExpandedChange?: (expanded: Set<string>) => void;
	selectedPaths?: Set<string>;
	onSelectRow?: (path: string, mods: SelectMods) => void;
	dropTargetPath?: string | null;
	onRowDragStart?: (path: string, e: DragEvent) => void;
	onRowDragOver?: (path: string, e: DragEvent) => void;
	onRowDrop?: (path: string, e: DragEvent) => void;
	onRowDragEnd?: () => void;
};

export const FileTree = ({
	expanded: controlledExpanded,
	defaultExpanded,
	selectedPath,
	onSelect,
	onDoubleClickPath,
	onContextMenuPath,
	onRenamePath,
	selectedPaths,
	onSelectRow,
	dropTargetPath,
	onRowDragStart,
	onRowDragOver,
	onRowDrop,
	onRowDragEnd,
	onExpandedChange,
	onKeyDown: onKeyDownProp,
	className,
	children,
	...props
}: FileTreeProps) => {
	const [internalExpanded, setInternalExpanded] = useState<Set<string>>(
		() => defaultExpanded ?? new Set(),
	);
	const expandedPaths = controlledExpanded ?? internalExpanded;
	const [cursorPath, setCursorPath] = useState<string | null>(null);

	const togglePath = useCallback(
		(path: string) => {
			const base = controlledExpanded ?? internalExpanded;
			const newExpanded = new Set(base);
			if (newExpanded.has(path)) {
				newExpanded.delete(path);
			} else {
				newExpanded.add(path);
			}
			if (!controlledExpanded) {
				setInternalExpanded(newExpanded);
			}
			onExpandedChange?.(newExpanded);
		},
		[controlledExpanded, internalExpanded, onExpandedChange],
	);

	/**
	 * Move the keyboard cursor. Arrow keys/`j/k/h/l` only move focus — they
	 * must not open the row: opening re-centres the sidebar and the next key
	 * would then jump back to the row that was just activated.
	 */
	const focusRow = useCallback((row: HTMLElement) => {
		row.focus();
		setCursorPath(row.dataset.path ?? null);
	}, []);

	/**
	 * Arrow keys navigate the flat, visible rows: up/down move,
	 * right expands or enters the first child, left collapses or goes to the
	 * parent folder — the WAI-ARIA tree pattern `j/k/h/l` builds on.
	 */
	const handleTreeKeyDown = useCallback(
		(event: KeyboardEvent<HTMLDivElement>) => {
			onKeyDownProp?.(event);
			const arrow = [
				"ArrowDown",
				"ArrowUp",
				"ArrowLeft",
				"ArrowRight",
			].includes(event.key);
			if (!arrow || event.defaultPrevented) return;
			if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) {
				return;
			}
			const target = event.target;
			const current =
				target instanceof HTMLElement
					? target.closest<HTMLElement>("[role='treeitem']")
					: null;
			if (!current || !event.currentTarget.contains(current)) return;
			const items = Array.from(
				event.currentTarget.querySelectorAll<HTMLElement>("[role='treeitem']"),
			).filter((item) => item.getClientRects().length > 0);
			const index = items.indexOf(current);
			if (index < 0) return;
			const path = current.dataset.path;
			const isFolder = current.hasAttribute("aria-expanded");
			const expanded = current.getAttribute("aria-expanded") === "true";

			if (event.key === "ArrowLeft") {
				// Collapse an open folder, otherwise step up to its parent row.
				// Toggle directly: clicking the row would also open it.
				if (isFolder && expanded && path) {
					event.preventDefault();
					togglePath(path);
					return;
				}
				const slash = path?.lastIndexOf("/") ?? -1;
				if (!path || slash <= 0) return;
				const parentPath = path.slice(0, slash);
				const parent = items.find((item) => item.dataset.path === parentPath);
				if (!parent) return;
				event.preventDefault();
				focusRow(parent);
				return;
			}

			if (event.key === "ArrowRight") {
				if (!isFolder) return;
				// Expand a closed folder; otherwise enter its first child row.
				if (!expanded) {
					if (!path) return;
					event.preventDefault();
					togglePath(path);
					return;
				}
				const next = items[index + 1];
				if (!next || !path) return;
				if (!next.dataset.path?.startsWith(`${path}/`)) return;
				event.preventDefault();
				focusRow(next);
				return;
			}

			const next = items[index + (event.key === "ArrowDown" ? 1 : -1)];
			if (!next) return;
			event.preventDefault();
			focusRow(next);
		},
		[onKeyDownProp, focusRow, togglePath],
	);

	const contextValue = useMemo(
		() => ({
			expandedPaths,
			onSelect,
			onDoubleClickPath,
			onContextMenuPath,
			onRenamePath,
			selectedPath,
			selectedPaths,
			onSelectRow,
			cursorPath,
			setCursorPath,
			dropTargetPath,
			onRowDragStart,
			onRowDragOver,
			onRowDrop,
			onRowDragEnd,
			togglePath,
		}),
		[
			expandedPaths,
			onSelect,
			onDoubleClickPath,
			onContextMenuPath,
			onRenamePath,
			selectedPath,
			selectedPaths,
			onSelectRow,
			cursorPath,
			dropTargetPath,
			onRowDragStart,
			onRowDragOver,
			onRowDrop,
			onRowDragEnd,
			togglePath,
		],
	);

	return (
		<FileTreeContext.Provider value={contextValue}>
			<div
				className={cn("text-sm", className)}
				role="tree"
				aria-multiselectable={Boolean(onSelectRow)}
				onKeyDown={handleTreeKeyDown}
				onBlur={(event) => {
					if (event.currentTarget.contains(event.relatedTarget as Node)) return;
					setCursorPath(null);
				}}
				{...props}
			>
				{children}
			</div>
		</FileTreeContext.Provider>
	);
};

export type FileTreeIconProps = HTMLAttributes<HTMLSpanElement>;

export const FileTreeIcon = ({
	className,
	children,
	...props
}: FileTreeIconProps) => (
	<span className={cn("shrink-0", className)} {...props}>
		{children}
	</span>
);

export type FileTreeNameProps = HTMLAttributes<HTMLSpanElement>;

export const FileTreeName = ({
	className,
	children,
	...props
}: FileTreeNameProps) => (
	<span className={cn("truncate", className)} {...props}>
		{children}
	</span>
);

/**
 * Keep the disclosure affordance in the row icon slot. This mirrors the
 * sidebar pattern used by Notion: the item identity is visible at rest, and
 * the same-sized expand/collapse affordance appears in its place when
 * targeted.
 */
export function FileTreeDisclosureIcon({
	isExpanded,
	icon,
}: {
	isExpanded: boolean;
	icon: ReactNode;
}) {
	return (
		<span className="relative flex size-4 shrink-0 items-center justify-center">
			<span className="transition-opacity duration-100 group-hover:opacity-0 group-focus-visible:opacity-0">
				{icon}
			</span>
			<ChevronRightIcon
				className={cn(
					"pointer-events-none absolute size-4 text-muted-foreground opacity-0 transition-[opacity,transform] duration-100 group-hover:opacity-100 group-focus-visible:opacity-100",
					isExpanded && "rotate-90",
				)}
				aria-hidden
			/>
		</span>
	);
}

/** Ring shown on the row a drag is currently hovering (valid drop target). */
const DROP_RING = "ring-1 ring-inset ring-primary bg-accent";
/** Row interaction states shared by the reading tree and the writing sidebar. */
export const FILE_TREE_ROW_STATE = `${TREE_ROW_TEXT_STATE} transition-colors duration-[var(--motion-duration-micro)] ease-[var(--motion-ease-out)] hover:bg-sidebar-accent/80 active:not-has-[[data-tex-compile]:active]:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-brand/80`;
export const FILE_TREE_ROW_SELECTED_STATE =
	"bg-sidebar-primary/75 text-sidebar-primary-foreground hover:text-sidebar-primary-foreground hover:bg-sidebar-primary/75 active:not-has-[[data-tex-compile]:active]:bg-sidebar-primary/75 [&_svg]:text-sidebar-primary-foreground/90";
/** `j/k` cursor: exactly the hover material, not the selected (opened) row. */
export const FILE_TREE_ROW_CURSOR_STATE =
	"bg-sidebar-accent/80 text-foreground";

/**
 * Flat folder ROW (no nested children) for virtualized rendering: renders the
 * folder button only; its children are separate flattened rows. Reads the same
 * FileTreeContext as {@link FileTreeFile}.
 */
export const FileTreeFolderRow = ({
	path,
	name,
	icon,
	className,
	style,
	openOnLabel = false,
	expandOnOpen = false,
	actions,
}: {
	path: string;
	name: string;
	/** Overrides the default folder glyph (e.g. the Library icon for `papers/`). */
	icon?: ReactNode;
	className?: string;
	/** Content inset; the row background still spans the full container. */
	style?: CSSProperties;
	openOnLabel?: boolean;
	expandOnOpen?: boolean;
	/** Trailing actions rendered inside the row background. */
	actions?: ReactNode;
}) => {
	const {
		expandedPaths,
		togglePath,
		selectedPath,
		selectedPaths,
		onSelectRow,
		onDoubleClickPath,
		onContextMenuPath,
		onRenamePath,
		dropTargetPath,
		cursorPath,
		setCursorPath,
		onRowDragStart,
		onRowDragOver,
		onRowDrop,
		onRowDragEnd,
	} = useContext(FileTreeContext);
	const isExpanded = expandedPaths.has(path);
	const selCount = selectedPaths?.size ?? 0;
	const isSelected =
		selCount > 0 ? (selectedPaths?.has(path) ?? false) : selectedPath === path;
	return (
		<div
			data-path={path}
			data-cursor={cursorPath === path ? "true" : undefined}
			draggable
			className={cn(
				"group flex h-7 min-h-7 w-full cursor-pointer items-center gap-1 rounded-md pl-2.5 pr-4 text-left text-sm font-normal",
				FILE_TREE_ROW_STATE,
				cursorPath === path && !isSelected && FILE_TREE_ROW_CURSOR_STATE,
				isSelected && FILE_TREE_ROW_SELECTED_STATE,
				dropTargetPath === path && DROP_RING,
				className,
			)}
			style={style}
			onFocus={() => setCursorPath(path)}
			onClick={(e) => {
				// Keep the row focused so Enter can start inline rename right
				// after a click (WebKit does not focus buttons on click).
				e.currentTarget.focus();
				if ((e.metaKey || e.ctrlKey || e.shiftKey) && onSelectRow) {
					onSelectRow(path, {
						meta: e.metaKey,
						ctrl: e.ctrlKey,
						shift: e.shiftKey,
					});
					return;
				}
				// Expand/collapse children in the tree AND notify selection so the
				// host can open a folder-scoped paper list in the center pane.
				if (
					!openOnLabel ||
					(e.target as HTMLElement).closest("[data-tree-disclosure]")
				) {
					togglePath(path);
					if (openOnLabel) return;
				} else if (expandOnOpen && !isExpanded) {
					togglePath(path);
				}
				onSelectRow?.(path, {
					meta: false,
					ctrl: false,
					shift: false,
				});
			}}
			onDoubleClick={(e) => {
				e.preventDefault();
				e.stopPropagation();
				onDoubleClickPath?.(path);
			}}
			onKeyDown={(e) => {
				if (e.target !== e.currentTarget) return;
				if (e.key === "Enter" && onRenamePath?.(path)) {
					e.preventDefault();
					return;
				}
				if (e.key === "Enter" || e.key === " ") {
					e.preventDefault();
					e.currentTarget.click();
				}
			}}
			onContextMenu={(e) => onContextMenuPath?.(path, e)}
			onDragStart={(e) => onRowDragStart?.(path, e)}
			onDragOver={(e) => onRowDragOver?.(path, e)}
			onDrop={(e) => onRowDrop?.(path, e)}
			onDragEnd={() => onRowDragEnd?.()}
			aria-expanded={isExpanded}
			aria-selected={isSelected}
			role="treeitem"
			tabIndex={0}
		>
			<span data-tree-disclosure className="inline-flex shrink-0">
				<FileTreeDisclosureIcon
					isExpanded={isExpanded}
					icon={
						icon ??
						(isExpanded ? (
							<FolderOpenIcon className="size-4 text-brand" aria-hidden />
						) : (
							<FolderIcon className="size-4 text-brand" aria-hidden />
						))
					}
				/>
			</span>
			<FileTreeName className="min-w-0 flex-1">{name}</FileTreeName>
			{actions ? (
				<FileTreeActions
					className="shrink-0"
					onClick={(e) => e.stopPropagation()}
					onDoubleClick={(e) => e.stopPropagation()}
					onKeyDown={(e) => e.stopPropagation()}
				>
					{actions}
				</FileTreeActions>
			) : null}
		</div>
	);
};

interface FileTreeFileContextType {
	path: string;
	name: string;
}

const FileTreeFileContext = createContext<FileTreeFileContextType>({
	name: "",
	path: "",
});

export type FileTreeFileProps = HTMLAttributes<HTMLDivElement> & {
	path: string;
	name: string;
	icon?: ReactNode;
};

export const FileTreeFile = ({
	path,
	name,
	icon,
	className,
	children,
	...props
}: FileTreeFileProps) => {
	const {
		selectedPath,
		onSelect,
		onDoubleClickPath,
		onContextMenuPath,
		onRenamePath,
		selectedPaths,
		onSelectRow,
		dropTargetPath,
		cursorPath,
		setCursorPath,
		onRowDragStart,
		onRowDragOver,
		onRowDrop,
		onRowDragEnd,
	} = useContext(FileTreeContext);
	const selCount = selectedPaths?.size ?? 0;
	const isSelected =
		selCount > 0 ? (selectedPaths?.has(path) ?? false) : selectedPath === path;

	const handleClick = useCallback(
		(e: MouseEvent) => {
			// Keep the row focused so Enter can start inline rename right after
			// a click (matches VS Code / Finder tree behavior).
			(e.currentTarget as HTMLElement).focus();
			if (onSelectRow) {
				onSelectRow(path, {
					meta: e.metaKey,
					ctrl: e.ctrlKey,
					shift: e.shiftKey,
				});
			} else {
				onSelect?.(path);
			}
		},
		[onSelect, onSelectRow, path],
	);

	const handleDoubleClick = useCallback(
		(e: MouseEvent) => {
			e.preventDefault();
			e.stopPropagation();
			onDoubleClickPath?.(path);
		},
		[onDoubleClickPath, path],
	);

	const handleContextMenu = useCallback(
		(e: MouseEvent) => {
			onContextMenuPath?.(path, e);
		},
		[onContextMenuPath, path],
	);

	const handleKeyDown = useCallback(
		(e: KeyboardEvent<HTMLDivElement>) => {
			// Enter on a real row starts inline rename (Finder-style); virtual
			// rows decline and keep Enter as activation.
			if (e.key === "Enter" && onRenamePath?.(path)) {
				e.preventDefault();
				return;
			}
			if (e.key === "Enter" || e.key === " ") {
				e.preventDefault();
				if (onSelectRow) {
					onSelectRow(path, {
						meta: e.metaKey,
						ctrl: e.ctrlKey,
						shift: e.shiftKey,
					});
				} else {
					onSelect?.(path);
				}
			}
		},
		[onRenamePath, onSelect, onSelectRow, path],
	);

	const fileContextValue = useMemo(() => ({ name, path }), [name, path]);

	return (
		<FileTreeFileContext.Provider value={fileContextValue}>
			<div
				data-path={path}
				data-cursor={cursorPath === path ? "true" : undefined}
				draggable
				className={cn(
					"group flex h-7 min-h-7 w-full cursor-pointer items-center gap-1 rounded-md pl-2.5 pr-4 text-sm font-normal",
					FILE_TREE_ROW_STATE,
					cursorPath === path && !isSelected && FILE_TREE_ROW_CURSOR_STATE,
					isSelected && FILE_TREE_ROW_SELECTED_STATE,
					dropTargetPath === path && DROP_RING,
					className,
				)}
				onFocus={() => setCursorPath(path)}
				onClick={handleClick}
				onDoubleClick={handleDoubleClick}
				onContextMenu={handleContextMenu}
				onKeyDown={handleKeyDown}
				onDragStart={(e) => onRowDragStart?.(path, e)}
				onDragOver={(e) => onRowDragOver?.(path, e)}
				onDrop={(e) => onRowDrop?.(path, e)}
				onDragEnd={() => onRowDragEnd?.()}
				role="treeitem"
				aria-selected={isSelected}
				tabIndex={0}
				{...props}
			>
				{children ?? (
					<>
						<FileTreeIcon>
							{icon ?? <FileIcon className="size-4 text-muted-foreground" />}
						</FileTreeIcon>
						<FileTreeName>{name}</FileTreeName>
					</>
				)}
			</div>
		</FileTreeFileContext.Provider>
	);
};

export type FileTreeActionsProps = HTMLAttributes<HTMLDivElement>;

export const FileTreeActions = ({
	className,
	children,
	...props
}: FileTreeActionsProps) => (
	<div className={cn("ml-auto flex items-center gap-1", className)} {...props}>
		{children}
	</div>
);
