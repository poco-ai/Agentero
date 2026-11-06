import {
	Bookmark,
	Check,
	ChevronDown,
	Copy,
	Languages,
	MessageSquare,
} from "lucide-react";
import {
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
import {
	HIGHLIGHT_COLOR_STACK_EXPANDED_W,
	HighlightColorStack,
} from "@/components/viewer/pdf/cards/highlight-color-stack";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import { useShortcutLabel } from "@/hooks/use-shortcut-label";
import { clamp } from "@/lib/core/math";
import type { HighlightColor } from "@/lib/pdf/highlight/palette";
import type { MenuContext } from "@/lib/shell/commands/menu-contributions";
import {
	activateMenuContribution,
	visibleMenuContributions,
} from "@/lib/shell/commands/menu-contributions";
import { formatModShortcut } from "@/lib/shell/shortcuts";
import { useSelectionOverlayGuard } from "@/lib/workspace/selection-overlay";

type SelectionMenuProps = {
	/** Screen point near the top-center of the selection (toolbar anchor) */
	screen: ScreenPoint;
	/** Create a highlight in the chosen color */
	onHighlight: (color: HighlightColor) => void;
	/** Open an in-page Ask (quick chat) thread for the selection. */
	onAsk: () => void;
	/** Open an optional inline comment before adding the quote to chat. */
	onAddToChat: () => void;
	onTranslate: () => void;
	onCopy?: () => Promise<boolean>;
	onBookmark?: () => void;
	onNote?: () => void;
	/** Show the highlight color stack (needs marks/ to persist into). */
	showHighlight?: boolean;
	/** Show the translate action (ephemeral cards on surfaces without marks/). */
	showTranslate?: boolean;
	/**
	 * PDF selection only. HTML and the text editor omit this, so their
	 * toolbars do not query `pdf.selection`.
	 */
	contributionContext?: MenuContext;
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

/**
 * Floating action bar shown next to a text selection: overlapping highlight
 * color dots (fan left on hover), Note / Translate / Copy / Add to chat, with
 * Quick chat in the split button's menu.
 * Copy keeps the bar open and swaps the icon for a check; it does not toast.
 * The bar is pinned by its right edge so expanding colors only grow left —
 * action buttons never shift.
 * `showHighlight` / `showTranslate` hide the persistent actions on surfaces
 * without marks/ (remote papers, proxied web pages).
 * Visible `pdf.selection` contributions append after the built-in buttons.
 */
export function SelectionMenu({
	screen,
	onHighlight,
	onAsk,
	onAddToChat,
	onTranslate,
	onCopy,
	onBookmark,
	onNote,
	showHighlight = true,
	showTranslate = true,
	contributionContext,
}: SelectionMenuProps) {
	const { t } = useTranslation("viewer");
	// Suspend dockview drag-and-drop while this toolbar floats over the tab
	// strip so a stray drag cannot split the layout (#608).
	useSelectionOverlayGuard();
	const quickChatShortcut = useShortcutLabel("quickChat");
	const addToChatShortcut = useShortcutLabel("addSelectionToChat");
	const copyShortcut = formatModShortcut("c");
	const contributions = contributionContext
		? visibleMenuContributions("pdf.selection", contributionContext)
		: [];
	const menuRef = useRef<HTMLDivElement>(null);
	const dividerRef = useRef<HTMLDivElement>(null);
	const colorsRef = useRef<HTMLFieldSetElement>(null);
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
			const divider = showHighlight
				? dividerRef.current?.getBoundingClientRect()
				: undefined;
			const anchor = divider
				? divider.left + divider.width / 2
				: rect.left + rect.width / 2;
			// Measure the action side, so labels and plugin actions need no estimates.
			// Keep `right` fixed while the color stack expands to the left.
			const expandedWidth =
				rect.width +
				(colorsRef.current
					? HIGHLIGHT_COLOR_STACK_EXPANDED_W -
						colorsRef.current.getBoundingClientRect().width
					: 0);
			const right = clamp(
				window.innerWidth - screen.x - (rect.right - anchor),
				EDGE,
				Math.max(EDGE, window.innerWidth - expandedWidth - EDGE),
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
	}, [screen.x, screen.y, showHighlight]);

	return (
		<SelectionToolbar
			ref={menuRef}
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
			onMouseDown={(e) => e.stopPropagation()}
		>
			<TooltipProvider delayDuration={200}>
				{showHighlight ? (
					<>
						<HighlightColorStack ref={colorsRef} onSelect={onHighlight} />
						{onNote ? (
							<SelectionToolbarIconButton
								label={t("selection.note")}
								onClick={onNote}
							>
								<MessageSquare className="size-3.5" />
							</SelectionToolbarIconButton>
						) : null}
						<SelectionToolbarDivider
							ref={dividerRef}
							data-selection-anchor=""
						/>
					</>
				) : null}
				{showTranslate ? (
					<SelectionToolbarIconButton
						label={t("selection.translate")}
						onClick={onTranslate}
					>
						<Languages className="size-3.5" />
					</SelectionToolbarIconButton>
				) : null}
				{onBookmark && (
					<SelectionToolbarIconButton
						label={t("pdf.bookmarks.add")}
						onClick={onBookmark}
					>
						<Bookmark className="size-3.5" />
					</SelectionToolbarIconButton>
				)}
				{onCopy ? (
					<SelectionCopyButton
						onCopy={onCopy}
						label={t("selection.copy")}
						copiedLabel={t("selection.copied")}
						shortcut={copyShortcut}
					/>
				) : null}

				<SelectionToolbarDivider />
				<div className="flex shrink-0 items-center">
					<SelectionToolbarAction
						label={t("selection.addToChat")}
						shortcut={addToChatShortcut}
						className="rounded-r-none"
						onClick={onAddToChat}
					/>
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
						<DropdownMenuContent align="end" data-pdf-chrome>
							<DropdownMenuItem onSelect={onAsk}>
								{t("selection.quickChat")}
								<kbd className="ml-auto pl-3 text-xs text-muted-foreground">
									{quickChatShortcut}
								</kbd>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
				{contributions.length > 0 ? (
					<>
						<SelectionToolbarDivider />
						{contributions.map((item) => (
							<SelectionToolbarAction
								key={item.id}
								label={item.title}
								onClick={() => {
									activateMenuContribution(item, contributionContext);
								}}
							/>
						))}
					</>
				) : null}
			</TooltipProvider>
		</SelectionToolbar>
	);
}
