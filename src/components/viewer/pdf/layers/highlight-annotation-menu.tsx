import type { AnnotationSelectionMenuProps } from "@embedpdf/plugin-annotation/react";
import { useAnnotationCapability } from "@embedpdf/plugin-annotation/react";
import { Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
	SelectionToolbar,
	SelectionToolbarDivider,
	SelectionToolbarIconButton,
} from "@/components/selection/selection-toolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HighlightColorStack } from "@/components/viewer/pdf/cards/highlight-color-stack";
import { cn } from "@/lib/core/utils";
import {
	highlightColorOf,
	isTextMarkupObject,
} from "@/lib/pdf/highlight/annotation-store";
import type { HighlightColor } from "@/lib/pdf/highlight/palette";

type HighlightAnnotationMenuProps = AnnotationSelectionMenuProps & {
	docId: string;
	onEdit: (id: string) => void;
	onDelete: (pageIndex: number, id: string) => void;
	onChangeColor: (pageIndex: number, id: string, color: HighlightColor) => void;
};

/**
 * Selection menu for text-highlight annotations. Appears when a highlight is
 * clicked in the PDF so plain highlights (no comment / no gutter pin) can still
 * be edited, recolored, or deleted without opening the side panel.
 */
export function HighlightAnnotationMenu({
	docId,
	context,
	selected,
	placement,
	menuWrapperProps,
	onEdit,
	onDelete,
	onChangeColor,
}: HighlightAnnotationMenuProps) {
	const { t } = useTranslation("viewer");
	const { provides: annotationCap } = useAnnotationCapability();
	const menuRef = useRef<HTMLDivElement | null>(null);

	const setRef = useCallback(
		(el: HTMLDivElement | null) => {
			menuRef.current = el;
			menuWrapperProps.ref(el);
		},
		[menuWrapperProps.ref],
	);

	// Dismiss the highlight selection when the user clicks anywhere outside the
	// menu. EmbedPDF's own deselect-on-background-click requires the click to
	// land exactly on the pointer-provider surface, which is usually covered by
	// child layers, so we handle it explicitly here.
	useEffect(() => {
		if (!selected || !annotationCap) return;
		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (!target || !menuRef.current) return;
			if (menuRef.current.contains(target)) return;
			annotationCap.forDocument(docId).deselectAnnotation();
		};
		document.addEventListener("pointerdown", handlePointerDown, true);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown, true);
		};
	}, [selected, annotationCap, docId]);

	if (!selected || context.type !== "annotation") return null;
	const obj = context.annotation.object;
	if (!isTextMarkupObject(obj)) return null;
	const activeColor = highlightColorOf(obj);

	return (
		<div {...menuWrapperProps} ref={setRef}>
			<TooltipProvider delayDuration={200}>
				<SelectionToolbar
					data-pdf-chrome
					aria-label={t("selection.highlightMenuLabel")}
					className={cn(
						"pointer-events-auto absolute z-10",
						placement.suggestTop ? "top-full mt-1.5" : "bottom-full mb-1.5",
					)}
					// Pin the toolbar by its right edge so the color stack fans left on
					// hover while the divider / edit / delete actions stay put — same
					// behavior as the text-selection highlight toolbar.
					style={{ right: "calc(50% - 68px)" }}
				>
					<HighlightColorStack
						activeColor={activeColor}
						tooltipSide={placement.suggestTop ? "bottom" : "top"}
						onSelect={(color) =>
							onChangeColor(context.pageIndex, obj.id, color)
						}
					/>
					<SelectionToolbarDivider className="mx-1" />
					<SelectionToolbarIconButton
						label={t("selection.editComment")}
						tooltipSide={placement.suggestTop ? "bottom" : "top"}
						className="text-muted-foreground hover:text-foreground"
						onClick={() => onEdit(obj.id)}
					>
						<Pencil className="size-4" />
					</SelectionToolbarIconButton>
					<SelectionToolbarIconButton
						label={t("selection.removeHighlight")}
						tooltipSide={placement.suggestTop ? "bottom" : "top"}
						className="text-muted-foreground hover:text-destructive"
						onClick={() => onDelete(context.pageIndex, obj.id)}
					>
						<Trash2 className="size-4" />
					</SelectionToolbarIconButton>
				</SelectionToolbar>
			</TooltipProvider>
		</div>
	);
}
