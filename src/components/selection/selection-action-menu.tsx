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
import { useSelectionOverlayGuard } from "@/lib/workspace/selection-overlay";

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
	/** Optional anchor and expansion reserve for a leading palette. */
	anchorRef?: RefObject<HTMLElement | null>;
	expandingRef?: RefObject<HTMLElement | null>;
	expandedWidth?: number;
};

const EDGE = 12;
const COPIED_FLASH_MS = 1500;

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
	anchorRef,
	expandingRef,
	expandedWidth = 0,
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
				event.altKey ||
				event.ctrlKey ||
				event.metaKey ||
				event.shiftKey ||
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
			const action = Array.from(
				menu.querySelectorAll<HTMLButtonElement>(
					"button[aria-keyshortcuts]:not(:disabled)",
				),
			).find(
				(button) =>
					button.getAttribute("aria-keyshortcuts")?.toLowerCase() ===
					event.key.toLowerCase(),
			);
			if (!action) {
				// Dropdown items live in a portal, so their single-key hints are
				// resolved from the action list instead of the toolbar DOM.
				const extra = moreActionsRef.current?.find(
					(item) => item.shortcut?.toLowerCase() === event.key.toLowerCase(),
				);
				if (!extra) return;
				event.preventDefault();
				extra.onSelect();
				return;
			}
			event.preventDefault();
			action.click();
		};
		window.addEventListener("keydown", onKeyDown, true);
		return () => window.removeEventListener("keydown", onKeyDown, true);
	}, []);

	useLayoutEffect(() => {
		const menu = menuRef.current;
		if (!menu) return;
		const place = () => {
			const rect = menu.getBoundingClientRect();
			const divider = anchorRef?.current?.getBoundingClientRect();
			// With a cursor endpoint, center the whole bar on it. Legacy
			// selection-center anchors keep the palette/action divider fixed so
			// expanding the color stack never moves the actions.
			const anchor =
				screen.cursorX != null
					? rect.left + rect.width / 2
					: divider
						? divider.left + divider.width / 2
						: rect.left + rect.width / 2;
			// Measure the action side, so labels and plugin actions need no estimates.
			// Keep `right` fixed while the color stack expands to the left.
			const reservedWidth =
				rect.width +
				(expandingRef?.current
					? expandedWidth - expandingRef.current.getBoundingClientRect().width
					: 0);
			// Center the bar on the gesture endpoint, not the selection center.
			const anchorX = screen.cursorX ?? screen.x;
			const right = clamp(
				window.innerWidth - anchorX - (rect.right - anchor),
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
							>
								{onAsk ? (
									<DropdownMenuItem onSelect={onAsk}>
										{t("selection.quickChat")}
										<kbd className="ml-auto pl-3 text-xs text-muted-foreground">
											{quickChatShortcut}
										</kbd>
									</DropdownMenuItem>
								) : null}
								{onAsk && moreActions?.length ? (
									<DropdownMenuSeparator />
								) : null}
								{moreActions?.map((action) => (
									<DropdownMenuItem key={action.id} onSelect={action.onSelect}>
										{action.icon}
										{action.label}
										{action.shortcut ? (
											<kbd className="ml-auto pl-3 text-xs text-muted-foreground">
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
