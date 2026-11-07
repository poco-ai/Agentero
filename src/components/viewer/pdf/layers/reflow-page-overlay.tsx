import { type CSSProperties, type RefObject, useRef } from "react";
import { AgenteroRenderLayer } from "@/components/viewer/pdf/layers/agentero-render-layer";
import { cn } from "@/lib/core/utils";
import { highlightFill } from "@/lib/pdf/highlight/palette";
import type { TranslateSentenceTint } from "@/lib/pdf/highlight/sentence-tint";
import {
	assignPreservedLinks,
	type GlyphRun,
	type PreservedLinkAssignment,
	type TranslateLinkBox,
} from "@/lib/pdf/layout/translated-links";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import {
	beginLinkPreviewDrag,
	linkHoverSuppressed,
	linkPreviewDragActive,
} from "@/lib/pdf/link-preview-drag";
import {
	PDF_PAGE_RASTER_DARK_CLASS,
	PDF_PAPER_TINT,
	type PdfPaperTone,
} from "@/lib/pdf/page-theme";
/** The PDF raster and transparent selection geometry share the export layout. */
export function ReflowPageOverlay({
	items,
	tints,
	preview,
	pageIndex,
	renderDocumentId,
	zoom,
	width,
	height,
	links,
	glyphRuns,
	onOpenLink,
	onHoverLink,
	tone = "white",
}: {
	items: readonly LayoutTranslateItem[];
	tints?: ReadonlyMap<string, ReadonlyMap<number, TranslateSentenceTint>>;
	preview: string;
	/** Source page index; the finished PDF keeps the same page order. */
	pageIndex: number;
	/** Finished translated PDF opened in the document manager. */
	renderDocumentId?: string | null;
	zoom: number;
	width: number;
	height: number;
	links?: readonly TranslateLinkBox[];
	glyphRuns?: readonly GlyphRun[];
	tone?: PdfPaperTone;
	onOpenLink?: (assignment: PreservedLinkAssignment) => void;
	onHoverLink?: (
		assignment: PreservedLinkAssignment | null,
		point: { x: number; y: number; top: number; bottom: number } | null,
	) => void;
}) {
	const reference = items.find((i) => i.reflow && i.bbox.w > 0 && i.bbox.h > 0);
	const sx = reference?.reflow
		? width / (reference.reflow.box.w / reference.bbox.w)
		: 1;
	const sy = reference?.reflow
		? height / (reference.reflow.box.h / reference.bbox.h)
		: 1;
	const renderRef: RefObject<HTMLDivElement | null> = useRef(null);
	return (
		<div className="pointer-events-none absolute inset-0">
			{/*
			 * Static per-page raster stays as the streaming fallback. Once the
			 * finished PDF is registered, the render layer sits on top and
			 * re-rasterizes at the viewer zoom / device pixel ratio — the same
			 * path the source page uses, instead of stretching a fixed image.
			 */}
			{preview ? (
				<img
					src={preview}
					alt=""
					draggable={false}
					className={cn(
						"absolute inset-0 h-full w-full",
						tone === "dark" && PDF_PAGE_RASTER_DARK_CLASS,
					)}
				/>
			) : null}
			{renderDocumentId ? (
				<div ref={renderRef} className="absolute inset-0">
					<AgenteroRenderLayer
						pageRef={renderRef}
						documentId={renderDocumentId}
						pageIndex={pageIndex}
						scale={zoom}
						className={tone === "dark" ? PDF_PAGE_RASTER_DARK_CLASS : undefined}
					/>
				</div>
			) : null}
			{PDF_PAPER_TINT[tone] && (
				<div
					className="absolute inset-0 mix-blend-multiply"
					style={{ backgroundColor: PDF_PAPER_TINT[tone] ?? undefined }}
				/>
			)}
			{items.map((item) => {
				const layout = item.reflowLayout;
				const tint = tints?.get(item.id)?.get(0);
				if (!layout) return null;
				const text = layout.units.map((u) => u.text).join("");
				const assignments = assignPreservedLinks(
					text,
					(links ?? []).filter((l) => {
						const x = l.box.x + l.box.w / 2,
							y = l.box.y + l.box.h / 2;
						return (
							x >= item.bbox.x &&
							x <= item.bbox.x + item.bbox.w &&
							y >= item.bbox.y &&
							y <= item.bbox.y + item.bbox.h
						);
					}),
					{ source: item.raw, block: item.bbox, runs: glyphRuns },
				);
				let offset = 0;
				return (
					<div
						key={item.id}
						data-layout-item={item.id}
						// The preview raster already paints the translated glyphs. This
						// layer only provides selection geometry. ::selection stays
						// transparent: one box per character would stack in the seam.
						// The line band paints the highlight once.
						data-reflow-selection="true"
						className="pdf-translate-selection pointer-events-auto absolute select-text"
						onPointerDownCapture={(event) => {
							if (event.button !== 0) return;
							beginLinkPreviewDrag();
						}}
						style={{
							left: layout.box.x * sx,
							top: layout.box.y * sy,
							width: layout.box.w * sx,
							height: layout.box.h * sy,
							color: "transparent",
						}}
					>
						<span data-sentence={0}>
							{layout.units.map((u) => {
								const start = offset;
								offset += u.text.length;
								const assignment = assignments.find(
									(a) => a.start < offset && a.end > start,
								);
								const style: CSSProperties = {
									position: "absolute",
									left: (u.x - layout.box.x) * sx,
									top:
										(u.y -
											layout.box.y -
											(u.formula ? u.height : u.fontSize * 0.8)) *
										sy,
									width: u.width * sx,
									height: u.height * sy,
									fontSize: u.fontSize * sy,
									lineHeight: 1,
									fontFamily: "serif",
									whiteSpace: "pre",
									color: "transparent",
									textDecoration: "none",
									backgroundColor: tint ? highlightFill(tint.color) : undefined,
								};
								const key = `${u.x}-${u.y}-${u.text}`;
								return assignment ? (
									<a
										key={key}
										style={style}
										href={assignment.url ?? "#"}
										draggable={false}
										aria-label={assignment.text}
										tabIndex={start === assignment.start ? 0 : -1}
										className="select-text"
										onDragStart={(event) => event.preventDefault()}
										onClick={(event) => {
											event.preventDefault();
											event.stopPropagation();
											if (!window.getSelection()?.toString())
												onOpenLink?.(assignment);
										}}
										onPointerEnter={(event) => {
											if (linkHoverSuppressed(event.buttons)) return;
											const b = event.currentTarget.getBoundingClientRect();
											onHoverLink?.(assignment, {
												x: b.left + b.width / 2,
												y: b.bottom,
												top: b.top,
												bottom: b.bottom,
											});
										}}
										onPointerLeave={() => {
											if (linkPreviewDragActive()) return;
											onHoverLink?.(null, null);
										}}
									>
										{u.text}
									</a>
								) : (
									<span key={key} style={style}>
										{u.text}
									</span>
								);
							})}
						</span>
					</div>
				);
			})}
		</div>
	);
}
