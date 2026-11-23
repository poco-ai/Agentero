import type { AnnotationSelectionMenuProps } from "@embedpdf/plugin-annotation/react";
import { useAnnotationCapability } from "@embedpdf/plugin-annotation/react";
import { Pencil, Trash2 } from "lucide-react";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
	SelectionToolbar,
	SelectionToolbarDivider,
	SelectionToolbarIconButton,
} from "@/components/selection/selection-toolbar";
import { TooltipProvider } from "@/components/ui/tooltip";
import { HighlightColorStack } from "@/components/viewer/pdf/cards/highlight-color-stack";
import {
	highlightColorOf,
	isTextMarkupObject,
} from "@/lib/pdf/highlight/annotation-store";
import {
	type HighlightMenuBox,
	type HighlightMenuPlacement,
	placeHighlightToolbar,
	unionHighlightBoxes,
} from "@/lib/pdf/highlight/menu-placement";
import type { HighlightColor } from "@/lib/pdf/highlight/palette";

function visibleHighlightBox(
	root: Element,
	id: string,
): HighlightMenuBox | null {
	const nodes = root.querySelectorAll(
		`[data-highlight-id="${CSS.escape(id)}"]`,
	);
	const boxes: HighlightMenuBox[] = [];
	for (const node of nodes) {
		if (!(node instanceof Element)) continue;
		const rect = node.getBoundingClientRect();
		boxes.push({
			left: rect.left,
			top: rect.top,
			right: rect.right,
			bottom: rect.bottom,
		});
	}
	return unionHighlightBoxes(boxes);
}

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
	menuWrapperProps,
	onEdit,
	onDelete,
	onChangeColor,
}: HighlightAnnotationMenuProps) {
	const { t } = useTranslation("viewer");
	const { provides: annotationCap } = useAnnotationCapability();
	const menuRef = useRef<HTMLDivElement | null>(null);
	const toolbarRef = useRef<HTMLDivElement | null>(null);
	const [placed, setPlaced] = useState<HighlightMenuPlacement | null>(null);
	const annotationId =
		selected &&
		context.type === "annotation" &&
		isTextMarkupObject(context.annotation.object)
			? context.annotation.object.id
			: null;

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
			if (toolbarRef.current?.contains(target)) return;
			annotationCap.forDocument(docId).deselectAnnotation();
		};
		document.addEventListener("pointerdown", handlePointerDown, true);
		return () => {
			document.removeEventListener("pointerdown", handlePointerDown, true);
		};
	}, [selected, annotationCap, docId]);

	useLayoutEffect(() => {
		if (!annotationId) {
			setPlaced(null);
			return;
		}
		const place = () => {
			const toolbar = toolbarRef.current;
			const anchor = menuRef.current;
			if (!toolbar || !anchor) return;
			const menuBox = toolbar.getBoundingClientRect();
			if (menuBox.width <= 0 || menuBox.height <= 0) return;
			const root = anchor.closest("[data-pdf-root]") ?? anchor;
			const anchorBox = anchor.getBoundingClientRect();
			const selection = visibleHighlightBox(root, annotationId) ?? {
				left: anchorBox.left,
				top: anchorBox.top,
				right: anchorBox.right,
				bottom: anchorBox.bottom,
			};
			const next = placeHighlightToolbar({
				selection,
				menu: { width: menuBox.width, height: menuBox.height },
				viewport: { width: window.innerWidth, height: window.innerHeight },
			});
			setPlaced((prev) =>
				prev &&
				prev.left === next.left &&
				prev.top === next.top &&
				prev.side === next.side
					? prev
					: next,
			);
		};
		place();
		const observer = new ResizeObserver(place);
		if (toolbarRef.current) observer.observe(toolbarRef.current);
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [annotationId]);

	if (!selected || context.type !== "annotation") return null;
	const obj = context.annotation.object;
	if (!isTextMarkupObject(obj)) return null;
	const activeColor = highlightColorOf(obj);
	const tooltipSide = placed?.side === "above" ? "top" : "bottom";

	return (
		<div {...menuWrapperProps} ref={setRef}>
			{createPortal(
				<TooltipProvider delayDuration={200}>
					<SelectionToolbar
						ref={toolbarRef}
						data-pdf-chrome
						aria-label={t("selection.highlightMenuLabel")}
						className="pointer-events-auto"
						style={{
							position: "fixed",
							top: placed?.top ?? 0,
							left: placed?.left ?? 0,
							zIndex: 50,
							visibility: placed ? "visible" : "hidden",
						}}
					>
						<HighlightColorStack
							activeColor={activeColor}
							tooltipSide={tooltipSide}
							onSelect={(color) =>
								onChangeColor(context.pageIndex, obj.id, color)
							}
						/>
						<SelectionToolbarDivider className="mx-1" />
						<SelectionToolbarIconButton
							label={t("selection.editComment")}
							tooltipSide={tooltipSide}
							className="text-muted-foreground hover:text-foreground"
							onClick={() => onEdit(obj.id)}
						>
							<Pencil className="size-4" />
						</SelectionToolbarIconButton>
						<SelectionToolbarIconButton
							label={t("selection.removeHighlight")}
							tooltipSide={tooltipSide}
							className="text-muted-foreground hover:text-destructive"
							onClick={() => onDelete(context.pageIndex, obj.id)}
						>
							<Trash2 className="size-4" />
						</SelectionToolbarIconButton>
					</SelectionToolbar>
				</TooltipProvider>,
				document.body,
			)}
		</div>
	);
}
