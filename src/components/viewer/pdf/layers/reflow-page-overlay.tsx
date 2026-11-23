import { type CSSProperties, type RefObject, useRef } from "react";
import { AgenteroRenderLayer } from "@/components/viewer/pdf/layers/agentero-render-layer";
import { cn } from "@/lib/core/utils";
import { HIGHLIGHT_HEX, highlightFill } from "@/lib/pdf/highlight/palette";
import type { TranslateSentenceTint } from "@/lib/pdf/highlight/sentence-tint";
import { groupReflowUnitsBySentence } from "@/lib/pdf/layout/layout-sentences";
import {
	activateTranslatedLinkClick,
	rememberTranslatedLinkOrigin,
	useCoalescedTranslatedLinkHover,
} from "@/lib/pdf/layout/translated-link-gesture";
import {
	assignPreservedLinks,
	claimTranslateLinks,
	type GlyphRun,
	type PreservedLinkAssignment,
	type TranslateLinkBox,
} from "@/lib/pdf/layout/translated-links";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import { mergeClientRectsIntoLines } from "@/lib/pdf/layout/visible-selection-rects";
import {
	beginLinkPreviewDrag,
	linkHoverSuppressed,
} from "@/lib/pdf/link-preview-drag";
import {
	PDF_PAGE_RASTER_DARK_CLASS,
	PDF_PAPER_TINT,
	type PdfPaperTone,
} from "@/lib/pdf/page-theme";
import type { PlacedUnit } from "@/lib/pdf/reflow/types";

type GlyphFrame = { left: number; top: number; width: number; height: number };

type GlyphPlacement = {
	unit: PlacedUnit;
	start: number;
	assignment: PreservedLinkAssignment | null;
};

/** Glyph box relative to the given origin. `y` on a unit is its baseline. */
function glyphFrame(
	unit: PlacedUnit,
	originX: number,
	originY: number,
	sx: number,
	sy: number,
): GlyphFrame {
	return {
		left: (unit.x - originX) * sx,
		top:
			(unit.y - originY - (unit.formula ? unit.height : unit.fontSize * 0.8)) *
			sy,
		width: unit.width * sx,
		height: unit.height * sy,
	};
}

/**
 * One hit target per link per line. A glyph-sized anchor leaves the hover
 * dwell every time the pointer crosses a character, and the gap between two
 * advances is not part of either glyph.
 */
function sameLinkLine(a: GlyphPlacement, b: GlyphPlacement): boolean {
	if (!a.assignment || a.assignment !== b.assignment) return false;
	const dy = Math.abs(a.unit.y - b.unit.y);
	const size = Math.max(a.unit.fontSize, b.unit.fontSize, 1);
	return dy <= size * 0.35;
}

function chunkPlacements(
	placed: readonly GlyphPlacement[],
): GlyphPlacement[][] {
	const groups: GlyphPlacement[][] = [];
	for (const item of placed) {
		const last = groups[groups.length - 1];
		const prev = last?.[last.length - 1];
		if (prev && last && sameLinkLine(prev, item)) last.push(item);
		else groups.push([item]);
	}
	return groups;
}

/**
 * One band per visual line. A fill on every glyph stacks in the seam and
 * paints over the rasterized character.
 */
export function reflowHighlightLineBands(
	glyphs: readonly GlyphFrame[],
): GlyphFrame[] {
	return mergeClientRectsIntoLines(glyphs);
}

function reflowSentenceGroups(
	item: LayoutTranslateItem,
	units: PlacedUnit[],
): { index?: number; units: PlacedUnit[] }[] {
	return groupReflowUnitsBySentence(
		item.translated ?? "",
		item.sentences,
		units,
	);
}

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
	const linkHover = useCoalescedTranslatedLinkHover(onHoverLink);
	const linksByItem = claimTranslateLinks(
		items.filter((item) => item.reflowLayout),
		links ?? [],
	);
	const placedItems = items.flatMap((item) => {
		const layout = item.reflowLayout;
		return layout
			? [{ item, layout, groups: reflowSentenceGroups(item, layout.units) }]
			: [];
	});
	const fillBands = placedItems.flatMap(({ item, groups }) =>
		groups.flatMap((group) => {
			const tint =
				group.index === undefined
					? undefined
					: tints?.get(item.id)?.get(group.index);
			if (!tint || tint.shape === "underline") return [];
			return reflowHighlightLineBands(
				group.units.map((unit) => glyphFrame(unit, 0, 0, sx, sy)),
			).map((line) => (
				<div
					key={`${item.id}:${group.index}:${line.left}:${line.top}:${line.width}`}
					style={{
						position: "absolute",
						...line,
						backgroundColor: highlightFill(tint.color),
						borderRadius: 1,
					}}
				/>
			));
		}),
	);
	return (
		<div className="pointer-events-none absolute inset-0">
			<div className="absolute inset-0 isolate">
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
							key={renderDocumentId}
							pageRef={renderRef}
							documentId={renderDocumentId}
							pageIndex={pageIndex}
							scale={zoom}
							className={
								tone === "dark" ? PDF_PAGE_RASTER_DARK_CLASS : undefined
							}
						/>
					</div>
				) : null}
				{PDF_PAPER_TINT[tone] && (
					<div
						className="absolute inset-0 mix-blend-multiply"
						style={{ backgroundColor: PDF_PAPER_TINT[tone] ?? undefined }}
					/>
				)}
				{/* Keep paint inside the raster's blend group and outside the text ranges. */}
				{fillBands.length > 0 ? (
					<div
						aria-hidden="true"
						className="pdf-reflow-highlight pointer-events-none absolute inset-0"
					>
						{fillBands}
					</div>
				) : null}
			</div>
			{placedItems.map(({ item, layout, groups }) => {
				const text = layout.units.map((u) => u.text).join("");
				const assignments = assignPreservedLinks(
					text,
					linksByItem.get(item.id) ?? [],
					{
						source: item.reflow?.source || item.source || item.raw,
						...(glyphRuns?.length ? { block: item.bbox, runs: glyphRuns } : {}),
					},
				);
				let offset = 0;
				const placedGroups = groups.map((group) => {
					const placed: GlyphPlacement[] = group.units.map((unit) => {
						const start = offset;
						offset += unit.text.length;
						return {
							unit,
							start,
							assignment:
								assignments.find(
									(assignment) =>
										assignment.start < offset && assignment.end > start,
								) ?? null,
						};
					});
					return { index: group.index, runs: chunkPlacements(placed) };
				});
				return (
					<div
						key={item.id}
						data-layout-item={item.id}
						// The preview raster already paints the translated glyphs. This
						// layer provides the text geometry for hover and selection.
						// Above the source citation hits (z-2) and the selection tint
						// (z-5), same slot as the block-overlay glyphs.
						data-reflow-selection="true"
						className="pdf-translate-selection pointer-events-auto absolute z-[6] select-text"
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
						{placedGroups.map((group) => {
							const tint =
								group.index === undefined
									? undefined
									: tints?.get(item.id)?.get(group.index);
							return (
								<span key={group.index ?? "block"} data-sentence={group.index}>
									{group.runs.map((run) => {
										const first = run[0];
										if (!first) return null;
										const frames = run.map((placed) =>
											glyphFrame(
												placed.unit,
												layout.box.x,
												layout.box.y,
												sx,
												sy,
											),
										);
										const glyphStyle = (
											frame: GlyphFrame,
											fontSize: number,
											left: number,
											top: number,
										): CSSProperties => ({
											position: "absolute",
											left: frame.left - left,
											top: frame.top - top,
											width: frame.width,
											height: frame.height,
											fontSize,
											lineHeight: 1,
											fontFamily: "serif",
											whiteSpace: "pre",
											color: "transparent",
											textDecoration: "none",
											...(tint?.shape === "underline"
												? {
														borderBottom: `2px solid ${HIGHLIGHT_HEX[tint.color]}`,
														boxSizing: "border-box" as const,
													}
												: null),
										});
										const key = `${first.unit.x}-${first.unit.y}-${first.start}`;
										const assignment = first.assignment;
										if (!assignment) {
											const frame = frames[0];
											if (!frame) return null;
											return (
												<span
													key={key}
													data-highlight-id={tint?.highlightId}
													style={glyphStyle(
														frame,
														first.unit.fontSize * sy,
														0,
														0,
													)}
												>
													{first.unit.text}
												</span>
											);
										}
										const left = Math.min(...frames.map((frame) => frame.left));
										const top = Math.min(...frames.map((frame) => frame.top));
										const right = Math.max(
											...frames.map((frame) => frame.left + frame.width),
										);
										const bottom = Math.max(
											...frames.map((frame) => frame.top + frame.height),
										);
										return (
											<a
												key={key}
												data-highlight-id={tint?.highlightId}
												href={assignment.url ?? "#"}
												draggable={false}
												aria-label={assignment.text}
												data-translated-link={
													assignment.key ?? assignment.url ?? ""
												}
												tabIndex={first.start === assignment.start ? 0 : -1}
												className="select-text"
												style={{
													position: "absolute",
													left,
													top,
													width: Math.max(0, right - left),
													height: Math.max(0, bottom - top),
													color: "transparent",
													textDecoration: "none",
												}}
												onDragStart={(event) => event.preventDefault()}
												onPointerDown={(event) => {
													if (event.button !== 0) return;
													rememberTranslatedLinkOrigin(event.currentTarget, {
														x: event.clientX,
														y: event.clientY,
													});
												}}
												onClick={(event) => {
													activateTranslatedLinkClick(event, () => {
														onOpenLink?.(assignment);
													});
												}}
												onPointerEnter={(event) => {
													if (linkHoverSuppressed(event.buttons)) return;
													const b = event.currentTarget.getBoundingClientRect();
													linkHover.enter(assignment, {
														x: b.left + b.width / 2,
														y: b.bottom,
														top: b.top,
														bottom: b.bottom,
													});
												}}
												onPointerLeave={() => {
													linkHover.leave();
												}}
											>
												{run.map((placed, index) => {
													const frame = frames[index];
													if (!frame) return null;
													return (
														<span
															key={`${placed.unit.x}-${placed.unit.y}-${placed.unit.text}`}
															style={glyphStyle(
																frame,
																placed.unit.fontSize * sy,
																left,
																top,
															)}
														>
															{placed.unit.text}
														</span>
													);
												})}
											</a>
										);
									})}
								</span>
							);
						})}
					</div>
				);
			})}
		</div>
	);
}
