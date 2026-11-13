import { Bookmark, MessageSquare } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	SelectionActionMenu,
	type SelectionMenuShortcut,
} from "@/components/selection/selection-action-menu";
import {
	SelectionToolbarAction,
	SelectionToolbarDivider,
	SelectionToolbarIconButton,
} from "@/components/selection/selection-toolbar";
import type { ScreenPoint } from "@/components/viewer/pdf/types";
import {
	type MarkupShapes,
	oppositeTextMarkupKind,
	readLastMarkupShape,
	readMarkupShapes,
	writeLastMarkupShape,
	writeMarkupShape,
} from "@/lib/pdf/highlight/markup-pref";
import {
	HIGHLIGHT_COLORS,
	type HighlightColor,
} from "@/lib/pdf/highlight/palette";
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
	const [shapes, setShapes] = useState<MarkupShapes>(readMarkupShapes);
	// Notes take no color, so they follow the last shape the user touched.
	const [noteShape, setNoteShape] =
		useState<PdfTextMarkupKind>(readLastMarkupShape);
	const toggleShape = useCallback(
		(color: HighlightColor) => {
			const next = oppositeTextMarkupKind(shapes[color]);
			writeMarkupShape(color, next);
			setShapes({ ...shapes, [color]: next });
			setNoteShape(next);
		},
		[shapes],
	);
	const applyShape = useCallback(
		(color: HighlightColor) => {
			const shape = shapes[color];
			writeMarkupShape(color, shape);
			setNoteShape(shape);
			onHighlight(color, shape);
		},
		[shapes, onHighlight],
	);
	/**
	 * Forced shape from a modifier shortcut: applies without flipping the
	 * swatch's remembered click shape.
	 */
	const applyForcedShape = useCallback(
		(color: HighlightColor, kind: PdfTextMarkupKind) => {
			writeLastMarkupShape(kind);
			setNoteShape(kind);
			onHighlight(color, kind);
		},
		[onHighlight],
	);
	// Bare digits come from the palette's aria hints. Each modifier prefix
	// forces one shape; a future wavy shape adds its own prefix here.
	const shortcutActions = useMemo<SelectionMenuShortcut[]>(
		() =>
			HIGHLIGHT_COLORS.map((color, i) => ({
				key: String(i + 1),
				alt: true,
				run: () => applyForcedShape(color, "underline"),
			})),
		[applyForcedShape],
	);
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
			shortcutActions={showHighlight ? shortcutActions : undefined}
			beforeActions={
				showHighlight ? (
					<>
						<HighlightColorStack
							ref={colorsRef}
							shapes={shapes}
							onToggleShape={toggleShape}
							onSelect={applyShape}
							shortcuts
						/>
						{onNote && (
							<SelectionToolbarIconButton
								label={t("selection.note")}
								shortcut="N"
								onClick={() => onNote(noteShape)}
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
