import { Bookmark, Highlighter, MessageSquare, Underline } from "lucide-react";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SelectionActionMenu } from "@/components/selection/selection-action-menu";
import {
	SelectionToolbarAction,
	SelectionToolbarDivider,
	SelectionToolbarIconButton,
} from "@/components/selection/selection-toolbar";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import type { HighlightColor } from "@/lib/pdf/highlight/palette";
import type { PdfTextMarkupKind } from "@/lib/pdf/highlight/types";
import {
	activateMenuContribution,
	type MenuContext,
	visibleMenuContributions,
} from "@/lib/shell/commands/menu-contributions";
import {
	HIGHLIGHT_COLOR_STACK_EXPANDED_W,
	HighlightColorStack,
} from "./highlight-color-stack";

type SelectionMenuProps = {
	screen: ScreenPoint;
	onHighlight: (color: HighlightColor, shape: PdfTextMarkupKind) => void;
	onAsk: () => void;
	onAddToChat: () => void;
	onTranslate: () => void;
	onCopy?: () => Promise<boolean>;
	onBookmark?: () => void;
	onNote?: (shape: PdfTextMarkupKind) => void;
	showHighlight?: boolean;
	showTranslate?: boolean;
	contributionContext?: MenuContext;
};

/** PDF-only extensions composed into the application selection menu. */
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
	const dividerRef = useRef<HTMLDivElement>(null);
	const colorsRef = useRef<HTMLFieldSetElement>(null);
	const [shape, setShape] = useState<PdfTextMarkupKind>("highlight");
	const contributions = contributionContext
		? visibleMenuContributions("pdf.selection", contributionContext)
		: [];
	return (
		<SelectionActionMenu
			screen={screen}
			onAsk={onAsk}
			onAddToChat={onAddToChat}
			onTranslate={showTranslate ? onTranslate : undefined}
			onCopy={onCopy}
			anchorRef={dividerRef}
			expandingRef={colorsRef}
			expandedWidth={HIGHLIGHT_COLOR_STACK_EXPANDED_W}
			beforeActions={
				showHighlight ? (
					<>
						<SelectionToolbarIconButton
							label={t("selection.shapeHighlight")}
							pressed={shape === "highlight"}
							onClick={() => setShape("highlight")}
						>
							<Highlighter className="size-3.5" />
						</SelectionToolbarIconButton>
						<SelectionToolbarIconButton
							label={t("selection.shapeUnderline")}
							pressed={shape === "underline"}
							onClick={() => setShape("underline")}
						>
							<Underline className="size-3.5" />
						</SelectionToolbarIconButton>
						<HighlightColorStack
							ref={colorsRef}
							onSelect={(color) => onHighlight(color, shape)}
							shortcuts
						/>
						{onNote && (
							<SelectionToolbarIconButton
								label={t("selection.note")}
								shortcut="N"
								onClick={() => onNote(shape)}
							>
								<MessageSquare className="size-3.5" />
							</SelectionToolbarIconButton>
						)}
						<SelectionToolbarDivider
							ref={dividerRef}
							data-selection-anchor=""
						/>
					</>
				) : undefined
			}
			moreActions={
				onBookmark
					? [
							{
								id: "bookmark",
								label: t("pdf.bookmarks.add"),
								icon: <Bookmark className="size-4" />,
								shortcut: "B",
								onSelect: onBookmark,
							},
						]
					: undefined
			}
			afterActions={
				contributions.length > 0 ? (
					<>
						<SelectionToolbarDivider />
						{contributions.map((item) => (
							<SelectionToolbarAction
								key={item.id}
								label={item.title}
								onClick={() =>
									activateMenuContribution(item, contributionContext)
								}
							/>
						))}
					</>
				) : undefined
			}
		/>
	);
}
