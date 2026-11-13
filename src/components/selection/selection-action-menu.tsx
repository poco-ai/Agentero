import { Check, ChevronDown, Copy, Languages } from "lucide-react";
import {
	type ReactNode,
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	SelectionToolbar,
	SelectionToolbarAction,
	SelectionToolbarDivider,
	SelectionToolbarIconButton,
} from "@/components/selection/selection-toolbar";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isEditableClipboardTarget } from "@/components/viewer/pdf/host-dom";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { useShortcutLabel } from "@/hooks/use-shortcut-label";
import { clamp } from "@/lib/core/math";
import {
	matchesAriaShortcut,
	matchShortcut,
	type ShortcutDef,
} from "@/lib/shell/shortcuts";
import { useSelectionOverlayGuard } from "@/lib/workspace/selection-overlay";

/**
 * Modifier shortcut owned by the menu source, such as ⌥1 → underline. Bare
 * single keys still come from the toolbar's `aria-keyshortcuts`.
 */
export type SelectionMenuShortcut = Pick<
	ShortcutDef,
	"key" | "meta" | "ctrl" | "alt" | "shift"
> & {
	run: () => void;
};

/** Secondary action collected by the trailing dropdown. */
export type SelectionMenuMoreAction = {
	id: string;
	label: string;
	/** Leading glyph; sized by the menu item styles. */
	icon?: ReactNode;
	/** Single-key hint; the key also works while the menu is mounted. */
	shortcut?: string;
	onSelect: () => void;
};

export type SelectionActionMenuProps = {
	screen: ScreenPoint & {
		selectionBounds?: {
			left: number;
			top: number;
			right: number;
			bottom: number;
		};
	};
	onAsk?: () => void;
	onAddToChat?: () => void;
	onTranslate?: () => void;
	onCopy?: () => Promise<boolean>;
	/** Source-specific actions, such as the PDF highlight palette. */
	beforeActions?: ReactNode;
	afterActions?: ReactNode;
	/** Secondary actions appended to the chat dropdown. */
	moreActions?: SelectionMenuMoreAction[];
	/** Source-specific modifier shortcuts, e.g. ⌥1 forces an underline. */
	shortcutActions?: SelectionMenuShortcut[];
	/** Optional anchor and expansion reserve for a leading palette. */
	anchorRef?: RefObject<HTMLElement | null>;
	expandingRef?: RefObject<HTMLElement | null>;
	expandedWidth?: number;
	/** Collapsed palette width; keeps expansion to the left of the actions. */
	collapsedWidth?: number;
};

const EDGE = 12;
const COPIED_FLASH_MS = 1500;

/**
 * The trailing dropdown continues the bar surface instead of reading as a
 * separate menu: same background and hairline, caption type, and a row height
 * that matches the bar's own action buttons.
 */
const SELECTION_MENU_CONTENT =
	"border border-border/80 bg-background p-1 text-foreground";
const SELECTION_MENU_ITEM = "h-7 gap-1.5 px-1.5 py-0 text-caption!";
const SELECTION_MENU_SHORTCUT =
	"ml-auto pl-2 text-caption text-muted-foreground/80";

function SelectionCopyButton({
	onCopy,
	label,
	copiedLabel,
	shortcut,
}: {
	onCopy: () => Promise<boolean>;
	label: string;
	copiedLabel: string;
	shortcut: string;
}) {
	const [copied, setCopied] = useState(false);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			if (timerRef.current) clearTimeout(timerRef.current);
		};
	}, []);

	const handleClick = useCallback(() => {
		void (async () => {
			const ok = await onCopy();
			if (!mountedRef.current || ok === false) return;
			setCopied(true);
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = setTimeout(() => {
				timerRef.current = null;
				if (mountedRef.current) setCopied(false);
			}, COPIED_FLASH_MS);
		})();
	}, [onCopy]);

	return (
		<SelectionToolbarIconButton
			label={copied ? copiedLabel : label}
			shortcut={shortcut}
			tooltip={label}
			onClick={handleClick}
		>
			{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
		</SelectionToolbarIconButton>
	);
}

/** Shared selection actions and measured placement; viewers supply extension slots. */
export function SelectionActionMenu({
	screen,
	onAsk,
	onAddToChat,
	onTranslate,
	onCopy,
	beforeActions,
	afterActions,
	moreActions,
	shortcutActions,
	anchorRef,
	expandingRef,
	expandedWidth = 0,
	collapsedWidth = 0,
}: SelectionActionMenuProps) {
	const { t } = useTranslation("viewer");
	// Suspend dockview drag-and-drop while this toolbar floats over the tab
	// strip so a stray drag cannot split the layout (#608).
	useSelectionOverlayGuard();
	const quickChatShortcut = useShortcutLabel("quickChat");
	const addToChatShortcut = useShortcutLabel("addSelectionToChat");
	const menuRef = useRef<HTMLDivElement>(null);
	const moreActionsRef = useRef(moreActions);
	moreActionsRef.current = moreActions;
	const shortcutActionsRef = useRef(shortcutActions);
	shortcutActionsRef.current = shortcutActions;
	const hasMoreMenu = Boolean(onAsk) || Boolean(moreActions?.length);
	const [position, setPosition] = useState<{
		right: number;
		top: number;
		dimmed: boolean;
	} | null>(null);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const menu = menuRef.current;
			if (
				!menu ||
				event.defaultPrevented ||
				event.isComposing ||
				event.repeat ||
				isEditableClipboardTarget(event.target)
			)
				return;
			const overlay =
				event.target instanceof Element
					? event.target.closest(
							"[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']",
						)
					: null;
			if (overlay && !overlay.contains(menu)) return;
			const modified =
				event.altKey || event.ctrlKey || event.metaKey || event.shiftKey;
			if (!modified) {
				const action = Array.from(
					menu.querySelectorAll<HTMLButtonElement>(
						"button[aria-keyshortcuts]:not(:disabled)",
					),
				).find((button) =>
					matchesAriaShortcut(
						button.getAttribute("aria-keyshortcuts"),
						event.key,
					),
				);
				if (action) {
					event.preventDefault();
					action.click();
					return;
				}
				// Dropdown items live in a portal, so their single-key hints are
				// resolved from the action list instead of the toolbar DOM.
				const extra = moreActionsRef.current?.find(
					(item) => item.shortcut?.toLowerCase() === event.key.toLowerCase(),
				);
				if (extra) {
					event.preventDefault();
					extra.onSelect();
					return;
				}
			}
			const custom = shortcutActionsRef.current?.find((item) =>
				matchShortcut(event, item),
			);
			if (!custom) return;
			event.preventDefault();
			custom.run();
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, []);

	useLayoutEffect(() => {
		const menu = menuRef.current;
		if (!menu) return;
		let leadingWidth: number | null = null;
		const place = () => {
			const rect = menu.getBoundingClientRect();
			const divider = anchorRef?.current?.getBoundingClientRect();
			const palette = expandingRef?.current?.getBoundingClientRect();
			// Measure from the palette's right edge, which stays fixed as it fans
			// left. Subtracting its animated width from the toolbar width combines
			// two independently rounded measurements and moves the action buttons.
			const trailingWidth = palette ? rect.right - palette.right : rect.width;
			leadingWidth ??= palette ? palette.left - rect.left : 0;
			const reservedWidth =
				leadingWidth + trailingWidth + (palette ? expandedWidth : 0);
			// Anchor to the collapsed bar so a palette that fans out left does not
			// also push the actions right: the right edge stays put while the
			// palette fieldset grows. Only the initial (collapsed) center follows
			// the cursor endpoint.
			const collapsedTotalWidth =
				leadingWidth + trailingWidth + (palette ? collapsedWidth : 0);
			// Center the collapsed bar on the gesture endpoint, not the selection
			// center; legacy anchors keep the palette/action divider fixed.
			const anchorX = screen.cursorX ?? screen.x;
			const right = clamp(
				window.innerWidth -
					anchorX -
					(screen.cursorX != null
						? collapsedTotalWidth / 2
						: divider
							? rect.right - (divider.left + divider.width / 2)
							: rect.width / 2),
				EDGE,
				Math.max(EDGE, window.innerWidth - reservedWidth - EDGE),
			);
			const topLimit = Math.max(EDGE, window.innerHeight - rect.height - EDGE);
			let top: number;
			let dimmed: boolean;
			const boundsTop = screen.selectionBounds?.top ?? screen.top ?? screen.y;
			const boundsBottom =
				screen.selectionBounds?.bottom ?? screen.bottom ?? screen.y;
			const hasSelectionBounds =
				screen.selectionBounds?.top !== undefined &&
				screen.selectionBounds?.bottom !== undefined;
			// Legacy anchors have no selection side: keep preferring above.
			if (screen.side === undefined && !hasSelectionBounds) {
				const above = screen.y - rect.height - 10;
				const overContent = above < EDGE;
				top = clamp(overContent ? screen.y + 18 : above, EDGE, topLimit);
				dimmed = overContent || top !== above;
			} else {
				// Follow the last cursor: downward drags open below, upward above.
				// Flip only when the preferred side has no room, then clamp.
				const above = boundsTop - rect.height - 10;
				const below = boundsBottom + 10;
				const aboveFits = above >= EDGE && above <= topLimit;
				const belowFits = below >= EDGE && below <= topLimit;
				const preferBelow = screen.side === "below";
				const preferredTop = preferBelow ? below : above;
				const flipTop = preferBelow ? above : below;
				const preferredFits = preferBelow ? belowFits : aboveFits;
				const flipFits = preferBelow ? aboveFits : belowFits;
				const chosenTop = preferredFits || !flipFits ? preferredTop : flipTop;
				top = clamp(chosenTop, EDGE, topLimit);
				dimmed = chosenTop !== preferredTop || top !== chosenTop;
			}
			setPosition((prev) =>
				prev?.right === right && prev.top === top && prev.dimmed === dimmed
					? prev
					: { right, top, dimmed },
			);
		};
		place();
		const observer = new ResizeObserver(place);
		observer.observe(menu);
		window.addEventListener("resize", place);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
		};
	}, [
		screen.x,
		screen.y,
		screen.cursorX,
		screen.side,
		screen.top,
		screen.bottom,
		screen.selectionBounds?.top,
		screen.selectionBounds?.bottom,
		anchorRef,
		expandingRef,
		expandedWidth,
		collapsedWidth,
	]);

	return (
		<SelectionToolbar
			ref={menuRef}
			data-selection-ui
			data-selection-menu
			data-pdf-chrome
			// Dim when covering body text or when the selection scrolled away.
			dimmed={position?.dimmed}
			className="fixed z-50"
			style={{
				top: position?.top ?? 0,
				right: position?.right ?? 0,
				visibility: position ? undefined : "hidden",
			}}
			aria-label={t("selection.menuLabel")}
			onMouseDown={(e) => {
				e.preventDefault();
				e.stopPropagation();
			}}
		>
			<TooltipProvider delayDuration={200}>
				{beforeActions}
				{onTranslate ? (
					<SelectionToolbarIconButton
						label={t("selection.translate")}
						shortcut="T"
						onClick={onTranslate}
					>
						<Languages className="size-3.5" />
					</SelectionToolbarIconButton>
				) : null}
				{onCopy ? (
					<SelectionCopyButton
						onCopy={onCopy}
						label={t("selection.copy")}
						copiedLabel={t("selection.copied")}
						shortcut="C"
					/>
				) : null}

				{(hasMoreMenu || onAddToChat) && <SelectionToolbarDivider />}
				<div className="flex shrink-0 items-center">
					{onAddToChat && (
						<SelectionToolbarAction
							label={t("selection.addToChat")}
							shortcut={addToChatShortcut}
							className={hasMoreMenu ? "rounded-r-none" : undefined}
							onClick={onAddToChat}
						/>
					)}
					{hasMoreMenu && (
						<DropdownMenu modal={false}>
							<DropdownMenuTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									className={onAddToChat ? "w-6 rounded-l-none" : "w-6"}
									aria-label={t("selection.moreActions")}
								>
									<ChevronDown className="size-3" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent
								align="end"
								data-pdf-chrome
								data-selection-ui
								className={SELECTION_MENU_CONTENT}
							>
								{onAsk ? (
									<DropdownMenuItem
										onSelect={onAsk}
										className={SELECTION_MENU_ITEM}
									>
										{t("selection.quickChat")}
										<kbd className={SELECTION_MENU_SHORTCUT}>
											{quickChatShortcut}
										</kbd>
									</DropdownMenuItem>
								) : null}
								{onAsk && moreActions?.length ? (
									<DropdownMenuSeparator className="-mx-1" />
								) : null}
								{moreActions?.map((action) => (
									<DropdownMenuItem
										key={action.id}
										onSelect={action.onSelect}
										className={SELECTION_MENU_ITEM}
									>
										{action.icon}
										{action.label}
										{action.shortcut ? (
											<kbd className={SELECTION_MENU_SHORTCUT}>
												{action.shortcut}
											</kbd>
										) : null}
									</DropdownMenuItem>
								))}
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
				{afterActions}
			</TooltipProvider>
		</SelectionToolbar>
	);
}
