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
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { useShortcutLabel } from "@/hooks/use-shortcut-label";
import { clamp } from "@/lib/core/math";
import { formatModShortcut } from "@/lib/shell/shortcuts";
import { useSelectionOverlayGuard } from "@/lib/workspace/selection-overlay";

export type SelectionActionMenuProps = {
	screen: ScreenPoint;
	onAsk?: () => void;
	onAddToChat?: () => void;
	onTranslate?: () => void;
	onCopy?: () => Promise<boolean>;
	/** Source-specific actions, such as the PDF highlight palette. */
	beforeActions?: ReactNode;
	afterActions?: ReactNode;
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
			shortcut={copied ? undefined : shortcut}
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
	const copyShortcut = formatModShortcut("c");
	const menuRef = useRef<HTMLDivElement>(null);
	const [position, setPosition] = useState<{
		right: number;
		top: number;
		dimmed: boolean;
	} | null>(null);

	useLayoutEffect(() => {
		const menu = menuRef.current;
		if (!menu) return;
		const place = () => {
			const rect = menu.getBoundingClientRect();
			const divider = anchorRef?.current?.getBoundingClientRect();
			const anchor = divider
				? divider.left + divider.width / 2
				: rect.left + rect.width / 2;
			// Measure the action side, so labels and plugin actions need no estimates.
			// Keep `right` fixed while the color stack expands to the left.
			const reservedWidth =
				rect.width +
				(expandingRef?.current
					? expandedWidth - expandingRef.current.getBoundingClientRect().width
					: 0);
			const right = clamp(
				window.innerWidth - screen.x - (rect.right - anchor),
				EDGE,
				Math.max(EDGE, window.innerWidth - reservedWidth - EDGE),
			);
			// Prefer above the selection, flipping below near the top edge.
			const above = screen.y - rect.height - 10;
			const overContent = above < EDGE;
			const top = clamp(
				overContent ? screen.y + 18 : above,
				EDGE,
				Math.max(EDGE, window.innerHeight - rect.height - EDGE),
			);
			const dimmed = overContent || top !== above;
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
	}, [screen.x, screen.y, anchorRef, expandingRef, expandedWidth]);

	return (
		<SelectionToolbar
			ref={menuRef}
			data-selection-ui
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
						shortcut={copyShortcut}
					/>
				) : null}

				{(onAsk || onAddToChat) && <SelectionToolbarDivider />}
				<div className="flex shrink-0 items-center">
					{onAddToChat && (
						<SelectionToolbarAction
							label={t("selection.addToChat")}
							shortcut={addToChatShortcut}
							className={onAsk ? "rounded-r-none" : undefined}
							onClick={onAddToChat}
						/>
					)}
					{onAsk && (
						<DropdownMenu modal={false}>
							<DropdownMenuTrigger asChild>
								<Button
									type="button"
									variant="ghost"
									size="icon-sm"
									className="w-6 rounded-l-none"
									aria-label={t("selection.chatActions")}
								>
									<ChevronDown className="size-3" />
								</Button>
							</DropdownMenuTrigger>
							<DropdownMenuContent
								align="end"
								data-pdf-chrome
								data-selection-ui
							>
								<DropdownMenuItem onSelect={onAsk}>
									{t("selection.quickChat")}
									<kbd className="ml-auto pl-3 text-xs text-muted-foreground">
										{quickChatShortcut}
									</kbd>
								</DropdownMenuItem>
							</DropdownMenuContent>
						</DropdownMenu>
					)}
				</div>
				{afterActions}
			</TooltipProvider>
		</SelectionToolbar>
	);
}
