import {
	PdfAnnotationSubtype,
	PdfBlendMode,
	type PdfHighlightAnnoObject,
	type PdfUnderlineAnnoObject,
} from "@embedpdf/models";
import type { BoxedAnnotationRenderer } from "@embedpdf/plugin-annotation/react";
import { PASSIVE_LINK_RENDERER } from "@/components/viewer/pdf/layers/link-annotation";

export const PASSIVE_HIGHLIGHT_RENDERER: BoxedAnnotationRenderer = {
	id: "highlight",
	matches: (annotation) => annotation.type === PdfAnnotationSubtype.HIGHLIGHT,
	render: ({ currentObject, scale }) => {
		const highlight = currentObject as PdfHighlightAnnoObject;
		const rect = highlight.rect;
		const segments = highlight.segmentRects?.length
			? highlight.segmentRects
			: [rect];
		return (
			<>
				{segments.map((segment) => (
					<div
						key={`${highlight.id}-${segment.origin.x}-${segment.origin.y}-${segment.size.width}-${segment.size.height}`}
						aria-hidden="true"
						style={{
							position: "absolute",
							left: (segment.origin.x - rect.origin.x) * scale,
							top: (segment.origin.y - rect.origin.y) * scale,
							width: segment.size.width * scale,
							height: segment.size.height * scale,
							backgroundColor:
								highlight.strokeColor ?? highlight.color ?? "#fcd34d",
							opacity: highlight.opacity ?? 0.4,
							pointerEvents: "none",
						}}
					/>
				))}
			</>
		);
	},
	zIndex: 0,
	defaultBlendMode: PdfBlendMode.Multiply,
	interactionDefaults: {
		isDraggable: false,
		isResizable: false,
		isRotatable: false,
	},
	useAppearanceStream: false,
};

/**
 * Solid bar under each selected line, matching the native `/Underline` tool.
 * The upstream renderer is equivalent, but this registry is the app's one
 * place for pointer-passive markup paint (and translation suppression).
 */
export const PASSIVE_UNDERLINE_RENDERER: BoxedAnnotationRenderer = {
	id: "underline",
	matches: (annotation) => annotation.type === PdfAnnotationSubtype.UNDERLINE,
	render: ({ currentObject, scale }) => {
		const underline = currentObject as PdfUnderlineAnnoObject;
		const rect = underline.rect;
		const segments = underline.segmentRects?.length
			? underline.segmentRects
			: [rect];
		return (
			<>
				{segments.map((segment) => (
					<div
						key={`${underline.id}-${segment.origin.x}-${segment.origin.y}-${segment.size.width}-${segment.size.height}`}
						aria-hidden="true"
						style={{
							position: "absolute",
							left: (segment.origin.x - rect.origin.x) * scale,
							top: (segment.origin.y - rect.origin.y) * scale,
							width: segment.size.width * scale,
							height: segment.size.height * scale,
							borderBottom: `2px solid ${
								underline.strokeColor ?? underline.color ?? "#fcd34d"
							}`,
							opacity: underline.opacity ?? 1,
							boxSizing: "border-box",
							pointerEvents: "none",
						}}
					/>
				))}
			</>
		);
	},
	zIndex: 0,
	interactionDefaults: {
		isDraggable: false,
		isResizable: false,
		isRotatable: false,
	},
	useAppearanceStream: false,
};

export const READING_ANNOTATION_RENDERERS: BoxedAnnotationRenderer[] = [
	PASSIVE_HIGHLIGHT_RENDERER,
	PASSIVE_UNDERLINE_RENDERER,
	PASSIVE_LINK_RENDERER,
];
