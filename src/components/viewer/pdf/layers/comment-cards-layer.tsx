/**
 * Comment cards for annotated highlights / visual notes, stacked vertically
 * with collision avoidance and clamped into the page height.
 *
 * Cards live outside the page's right edge (`left: 100%`), but the reading
 * surface reserves no space for them: at fit-width the column sits just past
 * the viewport and `RailPeek` pans the viewport when the pointer dwells on the
 * right edge. Narrow note embeds render `inset` instead (cards inside the
 * page, only the hovered / editing / brand-new one visible), because their
 * viewport is too small to peek without moving the content.
 *
 * Click a card to edit the note in place (Notion-style): the body becomes a
 * Markdown editor, ⌘/Ctrl+Enter or blur saves, Escape cancels. No floating
 * editor.
 *
 * Cards keep a fixed UI size like the ask / translate floating cards: the layer
 * is laid out in screen pixels (the page shell already tracks zoom), so zoom
 * only moves the anchors, never rescales the cards.
 *
 * Card height hugs the rendered content (measured, not estimated): short or
 * empty notes stay compact, long notes / conversations scroll inside the card.
 * The height cap also clamps to the reading viewport so short windows and
 * panes scroll the card body instead of clipping it. The scrolling box is the
 * card itself: the note never paints outside that box, so a later card cannot
 * cover the middle of an earlier one.
 */

import {
	Crop,
	Link2,
	MessageSquarePlus,
	Trash2,
	Underline,
} from "lucide-react";
import {
	memo,
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { MessageResponse } from "@/components/agent/message";
import { QuietIconButton } from "@/components/ui/quiet-icon-button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import {
	CommentMarkdownEditor,
	type CommentMarkdownEditorHandle,
} from "@/components/viewer/pdf/layers/comment-markdown-editor";
import type {
	PageAnnotationComment,
	SelectionCommentDraft,
} from "@/components/viewer/pdf/types";
import { useImeGuard } from "@/hooks/use-ime-guard";
import { cn } from "@/lib/core/utils";
import type { PdfAskNormalizedRect } from "@/lib/pdf/ask/types";
import {
	DEFAULT_HIGHLIGHT_COLOR,
	HIGHLIGHT_HEX,
	swatchColorClass,
} from "@/lib/pdf/highlight/palette";
/** Card width in CSS px. */
export const COMMENT_CARD_WIDTH_PX = 200;
/** Horizontal gap between the page edge and the card. */
export const COMMENT_CARD_GAP_PX = 8;
/** Extra px so ring + shadow aren't clipped by the scroll overflow. */
export const COMMENT_RAIL_BLEED_PX = 4;
/** Outer width of the page-outside card column (not reserved anywhere). */
export const COMMENT_RAIL_WIDTH_PX =
	COMMENT_CARD_WIDTH_PX + COMMENT_CARD_GAP_PX + COMMENT_RAIL_BLEED_PX;

const CARD_GAP_PX = 8;
/** text-xs leading-relaxed ≈ 12px × 1.625. */
const CARD_LINE_HEIGHT_PX = 20;
/** Conservative chars per line at w-50 with padding (CJK-heavy notes). */
const CARD_CHARS_PER_LINE = 13;
/** Padding + color-dot row + blockquote/comment margins. */
const CARD_BASE_HEIGHT_PX = 54;
/** Hard height cap so one huge note cannot dominate the rail. */
const COMMENT_CARD_MAX_HEIGHT_PX = 420;
/**
 * Smallest slot when a page cannot fit every card at its capped height.
 * Taller notes scroll inside the slot instead of overlapping a neighbour.
 */
const COMMENT_CARD_STACK_FLOOR_PX = 96;
/** Floor below the viewport-derived cap so short panes stay usable. */
const COMMENT_CARD_MIN_HEIGHT_PX = 120;
/** Keep the viewport-capped card clear of the reading-area edges. */
const COMMENT_VIEWPORT_MARGIN_PX = 12;
/** Layout seed for the note body (3 lines) until the card is measured. */
const VIEW_COMMENT_LINES = 3;
/** View-mode clamp for the inline visual-mark conversation preview. */
const VIEW_CONVERSATION_PREVIEW_LINES = 3;
/** In-place editor: min rows so an empty new note has room to type. */
const EDIT_MIN_COMMENT_LINES = 3;
/** In-place editor: layout estimate cap until the measured height lands. */
const EDIT_MAX_COMMENT_LINES = 12;
const COMMENT_CARD_SURFACE_CLASS =
	"pointer-events-auto w-full select-none rounded-lg border border-white/55 bg-background/88 shadow-overlay ring-1 ring-foreground/10 backdrop-blur-xl backdrop-saturate-150 transition-[box-shadow,background-color,transform] duration-150 ease-out supports-backdrop-blur:bg-background/70 dark:border-white/10";
const COMMENT_DRAFT_SURFACE_CLASS =
	"group/draft pointer-events-auto absolute z-[6] cursor-text overflow-hidden rounded-lg border border-white/55 bg-background/88 text-left shadow-overlay ring-1 ring-foreground/10 backdrop-blur-xl backdrop-saturate-150 outline-none supports-backdrop-blur:bg-background/70 dark:border-white/10";
/** Horizontal action bar floating just above the card's top-right corner. */
const COMMENT_ACTION_BAR_CLASS =
	"pointer-events-none absolute right-0 bottom-full z-[1] flex items-center gap-0.5 rounded-md border border-white/50 bg-background/82 p-0.5 shadow-raised ring-1 ring-foreground/10 backdrop-blur-xl backdrop-saturate-150 transition-opacity duration-150 group-hover:pointer-events-auto dark:border-white/10";

type CommentCardsLayerProps = {
	inset?: boolean;
	/** Comments for this page only. */
	items: PageAnnotationComment[];
	/** Rendered page width in px (zoom-aware); used by the hover connector. */
	pageWidthPx: number;
	/** Rendered page height in px (zoom-aware). */
	pageHeightPx: number;
	/** Id of the card currently being edited in place; null when idle. */
	editingId: string | null;
	/** Resolvable wiki target; copy buttons only render when set. */
	wikiTarget: string | null;
	/** Id of the card currently being hovered; null when idle. */
	hoveredId: string | null;
	/** Selection snapshot opened for editing from the toolbar. */
	selectionDraft?: SelectionCommentDraft | null;
	/** Persist a note from `selectionDraft` (non-empty text only). */
	onCommitSelectionComment?: (comment: string) => void;
	/** Editor is focused — keeps the draft after selection clear. */
	onSelectionCommentActiveChange?: (active: boolean) => void;
	/** Drop the sticky draft (Escape). */
	onDismissSelectionComment?: () => void;
	onOpen: (comment: PageAnnotationComment) => void;
	onSave: (comment: PageAnnotationComment, text: string) => void;
	onCancel: () => void;
	onDelete: (comment: PageAnnotationComment) => void;
	onCopyLink: (comment: PageAnnotationComment) => void;
	onCopyEmbed: (comment: PageAnnotationComment) => void;
	/** Add this visual mark's crop to the Agent sidebar composer (#396). */
	onAddToChat: (comment: PageAnnotationComment) => void;
	onHover: (comment: PageAnnotationComment) => void;
	onLeave: () => void;
};

export type CommentCardPlacement = {
	id: string;
	topPx: number;
	heightPx: number;
};

/** Visual line count after clamping (comment: view 3 / edit 12). */
function clampedLines(text: string, max: number): number {
	let lines = 0;
	for (const raw of text.split("\n")) {
		lines += Math.max(1, Math.ceil(raw.length / CARD_CHARS_PER_LINE));
		if (lines >= max) return max;
	}
	return Math.max(1, lines);
}

/**
 * Obsidian-style line parity for note cards: the in-place editor shows every
 * newline as a line break, so single newlines render as hard breaks instead
 * of joining into one paragraph. Blank lines already produce separate <p>s.
 */
function withEditorLineBreaks(text: string): string {
	return text.replace(/(?<!\n)\n(?!\n)/g, "  \n");
}

/**
 * Layout seed from clamped comment + conversation lines. The rail re-lays
 * out with measured card heights as soon as the cards report them; this
 * estimate only covers the first paint.
 */
export function estimateCommentCardHeight(
	item: PageAnnotationComment,
	editing = false,
): number {
	const commentLines = editing
		? Math.max(
				EDIT_MIN_COMMENT_LINES,
				clampedLines(item.comment, EDIT_MAX_COMMENT_LINES),
			)
		: clampedLines(item.comment, VIEW_COMMENT_LINES);
	const conversationPreviewLines =
		!editing && item.messages && item.messages.length > 0
			? Math.min(
					VIEW_CONVERSATION_PREVIEW_LINES,
					item.messages.reduce(
						(sum, m) => sum + clampedLines(m.content, VIEW_COMMENT_LINES),
						0,
					),
				)
			: 0;
	return (
		CARD_BASE_HEIGHT_PX +
		commentLines * CARD_LINE_HEIGHT_PX +
		conversationPreviewLines * CARD_LINE_HEIGHT_PX
	);
}

function cappedCardHeight(
	item: PageAnnotationComment,
	editingId: string | null | undefined,
	measuredHeights: ReadonlyMap<string, number> | undefined,
	maxHeightPx: number,
): number {
	const natural =
		measuredHeights?.get(item.id) ??
		estimateCommentCardHeight(item, item.id === editingId);
	return Math.min(Math.max(0, natural), Math.max(0, maxHeightPx));
}

/** Follow anchors, then lift overflowing cards backwards while retaining gaps. */
function placeCardTops(
	items: readonly PageAnnotationComment[],
	heights: readonly number[],
	pageHeightPx: number,
): number[] {
	const tops: number[] = [];
	for (let i = 0; i < items.length; i += 1) {
		const anchorTop = items[i].anchorY * pageHeightPx;
		const prevBottom = i > 0 ? tops[i - 1] + heights[i - 1] + CARD_GAP_PX : 0;
		tops.push(Math.max(anchorTop, prevBottom));
	}
	if (tops.length === 0) return tops;
	for (let i = tops.length - 1; i >= 0; i -= 1) {
		const bottom =
			i === tops.length - 1 ? pageHeightPx : tops[i + 1] - CARD_GAP_PX;
		tops[i] = Math.min(tops[i], bottom - heights[i]);
	}
	return tops;
}

/** Give the deficit back by shortening the tallest slots, never below the floor. */
function shrinkSlotsToFit(
	heights: number[],
	deficit: number,
	pageHeightPx: number,
): void {
	if (deficit <= 0) return;
	const floor = Math.min(
		COMMENT_CARD_STACK_FLOOR_PX,
		Math.max(
			0,
			(pageHeightPx - CARD_GAP_PX * (heights.length - 1)) / heights.length,
		),
	);
	const slack = heights.map((height) => Math.max(0, height - floor));
	const totalSlack = slack.reduce((sum, value) => sum + value, 0);
	if (totalSlack <= 0) return;
	const cut = Math.min(deficit, totalSlack);
	for (let i = 0; i < heights.length; i += 1) {
		if (slack[i] === 0) continue;
		heights[i] -= (cut * slack[i]) / totalSlack;
	}
}

/**
 * Anchor each card at its highlight, then keep later cards below earlier ones.
 * Heights are the visible slot: a measured note taller than the cap scrolls
 * inside that cap, and neighbours stack under the cap rather than through the
 * lines that would otherwise paint past it.
 *
 * Backwards clamping retains gaps instead of pinning each overflowing card
 * separately at zero. On short pages the visible slots shrink, with each
 * note scrolling internally, so the stack does not cover the next page.
 */
export function layoutCommentCards(
	items: PageAnnotationComment[],
	pageHeightPx: number,
	editingId?: string | null,
	measuredHeights?: ReadonlyMap<string, number>,
	maxHeightPx: number = COMMENT_CARD_MAX_HEIGHT_PX,
): CommentCardPlacement[] {
	const sorted = [...items].sort(
		(a, b) => a.anchorY - b.anchorY || a.id.localeCompare(b.id),
	);
	const heights = sorted.map((item) =>
		cappedCardHeight(item, editingId, measuredHeights, maxHeightPx),
	);
	let tops = placeCardTops(sorted, heights, pageHeightPx);
	if (tops.length > 0 && tops[0] < 0) {
		shrinkSlotsToFit(heights, -tops[0], pageHeightPx);
		tops = placeCardTops(sorted, heights, pageHeightPx);
		if (tops[0] < 0) {
			const pin = -tops[0];
			for (let i = 0; i < tops.length; i += 1) tops[i] += pin;
		}
	}
	return sorted.map((item, index) => ({
		id: item.id,
		topPx: tops[index],
		heightPx: heights[index],
	}));
}

/**
 * Word / Feishu-style orthogonal leader from the nearest highlight segment to
 * the laid-out card's left midpoint, folding at the page's right edge.
 * Multi-line highlights pick the rect closest to the card (not the envelope mid).
 * Returns an SVG path `d` in screen-space pixels, or null when undrawable.
 */
export function commentConnectorPath(
	rects: readonly PdfAskNormalizedRect[],
	placement: CommentCardPlacement,
	pageWidthPx: number,
	pageHeightPx: number,
): string | null {
	if (rects.length === 0 || pageWidthPx <= 0 || pageHeightPx <= 0) return null;

	const round = (n: number) => Math.round(n * 100) / 100;
	const y2 = placement.topPx + placement.heightPx / 2;
	const y2Norm = y2 / pageHeightPx;

	let best = rects[0];
	let bestDist = Number.POSITIVE_INFINITY;
	for (const rect of rects) {
		const top = rect.y;
		const bottom = rect.y + rect.h;
		// Distance from the card mid to the closest point inside this segment.
		const clamped = Math.min(Math.max(y2Norm, top), bottom);
		const dist = Math.abs(clamped - y2Norm);
		const right = rect.x + rect.w;
		const bestRight = best.x + best.w;
		if (
			dist < bestDist ||
			(dist === bestDist &&
				(right > bestRight || (right === bestRight && rect.y < best.y)))
		) {
			best = rect;
			bestDist = dist;
		}
	}

	const attachYNorm = Math.min(Math.max(y2Norm, best.y), best.y + best.h);
	const x1 = round((best.x + best.w) * pageWidthPx);
	const y1 = round(attachYNorm * pageHeightPx);
	const xMid = round(pageWidthPx);
	const x2 = round(pageWidthPx + COMMENT_CARD_GAP_PX);
	const y2Rounded = round(y2);

	return `M ${x1} ${y1} L ${xMid} ${y1} L ${xMid} ${y2Rounded} L ${x2} ${y2Rounded}`;
}

type CommentCardProps = {
	inset?: boolean;
	item: PageAnnotationComment;
	topPx: number;
	/** Visible slot. Taller notes scroll inside this height. */
	maxHeightPx: number;
	editing: boolean;
	wikiTarget: string | null;
	hovered: boolean;
	/** Report the rendered card height so stacking uses real sizes. */
	onMeasure: (id: string, heightPx: number) => void;
	onOpen: (comment: PageAnnotationComment) => void;
	onSave: (comment: PageAnnotationComment, text: string) => void;
	onCancel: () => void;
	onDelete: (comment: PageAnnotationComment) => void;
	onCopyLink: (comment: PageAnnotationComment) => void;
	onCopyEmbed: (comment: PageAnnotationComment) => void;
	onAddToChat: (comment: PageAnnotationComment) => void;
	onHover: (comment: PageAnnotationComment) => void;
	onLeave: () => void;
};

/** Shape glyph at the top of a card: crop for visual notes, color bar / dot. */
function MarkerGlyph({
	kind,
	color,
	shape,
}: Pick<PageAnnotationComment, "kind" | "color" | "shape">) {
	if (kind === "visual") {
		return <Crop className="size-2.5 text-muted-foreground" aria-hidden />;
	}
	if (shape === "underline") {
		return (
			<Underline
				className="size-3"
				style={{ color: HIGHLIGHT_HEX[color] }}
				aria-hidden
			/>
		);
	}
	return (
		<span
			className={cn("block size-2 rounded-full", swatchColorClass(color))}
			aria-hidden
		/>
	);
}

const CommentCard = memo(function CommentCard({
	inset,
	item,
	topPx,
	maxHeightPx,
	editing,
	wikiTarget,
	hovered,
	onMeasure,
	onOpen,
	onSave,
	onCancel,
	onDelete,
	onCopyLink,
	onCopyEmbed,
	onAddToChat,
	onHover,
	onLeave,
}: CommentCardProps) {
	const { t } = useTranslation("viewer");
	const rootRef = useRef<HTMLDivElement>(null);
	const bodyRef = useRef<HTMLDivElement>(null);
	const editorHandleRef = useRef<CommentMarkdownEditorHandle | null>(null);
	const cancelledRef = useRef(false);
	const itemRef = useRef(item);
	itemRef.current = item;
	const onSaveRef = useRef(onSave);
	onSaveRef.current = onSave;
	const onCancelRef = useRef(onCancel);
	onCancelRef.current = onCancel;
	const draftRef = useRef(item.comment);
	const commentSeedRef = useRef(item.comment);
	commentSeedRef.current = item.comment;
	// True once the editable itself has taken focus this edit session. WebKit
	// fires a queued focusout when the focused view body is swapped out for the
	// editor; until the editable focuses, any blur is that swap, not a click-away.
	const editorFocusedRef = useRef(false);
	const { isBlockedByIme } = useImeGuard();

	// The WYSIWYG editor reads back as Markdown at commit points; blur races
	// fall back to the last onChange draft (seeded with the stored comment).
	const readDraft = useCallback(
		() => editorHandleRef.current?.getMarkdown() ?? draftRef.current,
		[],
	);

	// Reset the commit guard each time editing opens.
	useLayoutEffect(() => {
		if (!editing) return;
		cancelledRef.current = false;
		editorFocusedRef.current = false;
		draftRef.current = commentSeedRef.current;
	}, [editing]);

	// Report the note's natural height, including lines the slot scrolls away.
	// The clamped border box is shorter than that text; feeding it back into
	// layout lets the next card move up and cover the middle of the note.
	// `editing` swaps that child, so the observer has to attach again.
	// biome-ignore lint/correctness/useExhaustiveDependencies: view/edit swap replaces the measured child
	useLayoutEffect(() => {
		const body = bodyRef.current;
		if (!body) return;
		let last = -1;
		const report = () => {
			const content = body.firstElementChild;
			const surface = body.parentElement;
			if (!(content instanceof HTMLElement) || !surface) return;
			const scrollerStyle = getComputedStyle(body);
			const surfaceStyle = getComputedStyle(surface);
			const chrome =
				Number.parseFloat(scrollerStyle.paddingTop) +
				Number.parseFloat(scrollerStyle.paddingBottom) +
				Number.parseFloat(scrollerStyle.borderTopWidth) +
				Number.parseFloat(scrollerStyle.borderBottomWidth) +
				Number.parseFloat(surfaceStyle.paddingTop) +
				Number.parseFloat(surfaceStyle.paddingBottom) +
				Number.parseFloat(surfaceStyle.borderTopWidth) +
				Number.parseFloat(surfaceStyle.borderBottomWidth);
			const height = Math.ceil(content.offsetHeight + chrome);
			if (height > 0 && height !== last) {
				last = height;
				onMeasure(item.id, height);
			}
		};
		report();
		const observer = new ResizeObserver(report);
		observer.observe(body);
		const content = body.firstElementChild;
		if (content) observer.observe(content);
		return () => observer.disconnect();
	}, [editing, item.id, onMeasure]);

	// Page virtualization unmounts the card if the user scrolls away — treat
	// dirty drafts like blur and commit. Skip no-op saves so React StrictMode's
	// fake unmount doesn't close a freshly opened editor. Serialize output is
	// normalized (trailing newline etc.), so compare without edge whitespace.
	useEffect(() => {
		if (!editing) return;
		return () => {
			if (cancelledRef.current) return;
			if (draftRef.current.trim() === commentSeedRef.current.trim()) return;
			onSaveRef.current(itemRef.current, draftRef.current);
		};
	}, [editing]);

	const commit = (text: string) => {
		cancelledRef.current = true;
		draftRef.current = text;
		onSave(item, text);
	};

	const cancel = () => {
		cancelledRef.current = true;
		onCancel();
	};

	// Clicking the page does not always blur the editor. A new empty note
	// should disappear on that click; typed text still commits.
	useEffect(() => {
		if (!editing) return;
		const onPointerDown = (event: PointerEvent) => {
			const current = itemRef.current;
			if (!current.isNew || cancelledRef.current) return;
			const target = event.target as Node | null;
			if (
				!target ||
				rootRef.current?.contains(target) ||
				editorHandleRef.current?.ownsEquationPopover(target)
			)
				return;
			const text = readDraft();
			if (!text.trim()) {
				cancelledRef.current = true;
				onCancelRef.current();
				return;
			}
			cancelledRef.current = true;
			draftRef.current = text;
			onSaveRef.current(current, text);
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, [editing, readDraft]);

	return (
		<div
			ref={rootRef}
			data-pdf-chrome
			data-comment-card
			className={cn(
				"group pointer-events-auto absolute",
				editing || hovered ? "z-[6]" : "hover:z-[7]",
			)}
			style={{
				...(inset
					? { right: COMMENT_CARD_GAP_PX }
					: { left: `calc(100% + ${COMMENT_CARD_GAP_PX}px)` }),
				top: topPx,
				width: COMMENT_CARD_WIDTH_PX,
			}}
			onPointerEnter={() => onHover(item)}
			onPointerLeave={onLeave}
		>
			<div
				className={cn(
					COMMENT_CARD_SURFACE_CLASS,
					editing
						? "bg-background/92 ring-1 ring-ring"
						: hovered
							? "bg-background/92 ring-1 ring-primary/60"
							: "",
				)}
			>
				{/* biome-ignore lint/a11y/noStaticElementInteractions: blur/pointer isolation for the in-place editor */}
				<div
					ref={bodyRef}
					className="agentero-scroll w-full overflow-auto overscroll-contain rounded-[inherit] px-2.5 py-2 text-left"
					// The slot includes the surface's top and bottom 1px borders.
					style={{ maxHeight: Math.max(0, maxHeightPx - 2) }}
					onPointerDown={(e) => e.stopPropagation()}
					onBlur={
						editing
							? (e) => {
									const next = e.relatedTarget as Node | null;
									if (
										next &&
										(e.currentTarget.contains(next) ||
											rootRef.current?.contains(next) ||
											editorHandleRef.current?.ownsEquationPopover(next))
									) {
										return;
									}
									// Ignore the view→edit swap: WebKit queues a focusout
									// when the focused view body unmounts. It is not a
									// click-away until the editable has focus and focus has
									// actually left the card.
									if (!editorFocusedRef.current) return;
									// Focus can already be in the portal without a relatedTarget.
									const active = document.activeElement;
									if (
										rootRef.current?.contains(active) ||
										editorHandleRef.current?.ownsEquationPopover(active)
									) {
										return;
									}
									if (cancelledRef.current) return;
									const text = readDraft();
									if (item.isNew && !text.trim()) {
										cancel();
										return;
									}
									commit(text);
								}
							: undefined
					}
				>
					{editing ? (
						<div className="block w-full text-left">
							<MarkerGlyph
								kind={item.kind}
								color={item.color}
								shape={item.shape}
							/>
							<CommentMarkdownEditor
								initialValue={item.comment}
								placeholder={t("annotations.placeholder")}
								ariaLabel={t("annotations.editorLabel")}
								className="comment-md mt-1 w-full overflow-y-auto break-words text-sm leading-relaxed text-foreground/80"
								handleRef={editorHandleRef}
								onChange={(markdown) => {
									draftRef.current = markdown;
								}}
								onFocus={() => {
									editorFocusedRef.current = true;
								}}
								onKeyDown={(e) => {
									e.stopPropagation();
									if (e.key === "Escape") {
										e.preventDefault();
										cancel();
										return;
									}
									if (
										e.key === "Enter" &&
										(e.metaKey || e.ctrlKey) &&
										!isBlockedByIme(e)
									) {
										e.preventDefault();
										commit(readDraft());
									}
								}}
							/>
						</div>
					) : (
						// biome-ignore lint/a11y/useSemanticElements: a native <button> cannot wrap the blockquote/p flow content
						<div
							role="button"
							tabIndex={0}
							className="block w-full cursor-text text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
							onClick={(e) => {
								e.stopPropagation();
								if ((e.target as Element).closest("a, button")) return;
								onOpen(item);
							}}
							onKeyDown={(e) => {
								if (e.target !== e.currentTarget) return;
								if (e.key === "Enter" || e.key === " ") {
									e.preventDefault();
									onOpen(item);
								}
							}}
						>
							<MarkerGlyph
								kind={item.kind}
								color={item.color}
								shape={item.shape}
							/>
							<div
								className={cn(
									"mt-1 break-words text-sm leading-relaxed",
									item.comment.trim()
										? "text-foreground/80"
										: "text-muted-foreground/70",
								)}
							>
								{item.comment.trim() ? (
									<MessageResponse className="comment-md text-sm leading-relaxed [&_table]:min-w-max">
										{withEditorLineBreaks(item.comment)}
									</MessageResponse>
								) : (
									t("annotations.placeholder")
								)}
							</div>
							{item.messages && item.messages.length > 0 ? (
								<div className="mt-1.5 space-y-1 border-t border-border/40 pt-1.5">
									{item.messages.map((m) => (
										<p
											key={m.id}
											className={cn(
												"whitespace-pre-wrap break-words text-caption leading-relaxed",
												m.role === "assistant"
													? "text-muted-foreground"
													: "text-foreground/80",
											)}
										>
											{m.content}
										</p>
									))}
								</div>
							) : null}
						</div>
					)}
				</div>
			</div>
			<div
				className={cn(
					COMMENT_ACTION_BAR_CLASS,
					editing
						? "opacity-0 group-hover:opacity-100"
						: "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
				)}
			>
				{wikiTarget ? (
					<>
						<Tooltip>
							<TooltipTrigger asChild>
								<QuietIconButton
									aria-label={t("annotations.copyLink")}
									onClick={(e) => {
										e.stopPropagation();
										onCopyLink(item);
									}}
								>
									<Link2 className="size-3.5" />
								</QuietIconButton>
							</TooltipTrigger>
							<TooltipContent>{t("annotations.copyLink")}</TooltipContent>
						</Tooltip>
						<Tooltip>
							<TooltipTrigger asChild>
								<QuietIconButton
									aria-label={t("annotations.copyEmbed")}
									onClick={(e) => {
										e.stopPropagation();
										onCopyEmbed(item);
									}}
								>
									<span className="font-mono text-caption leading-none">
										![[
									</span>
								</QuietIconButton>
							</TooltipTrigger>
							<TooltipContent>{t("annotations.copyEmbed")}</TooltipContent>
						</Tooltip>
					</>
				) : null}
				<Tooltip>
					<TooltipTrigger asChild>
						<QuietIconButton
							aria-label={t("pdfExplain.addToSidebarChat")}
							onClick={(e) => {
								e.stopPropagation();
								onAddToChat(item);
							}}
						>
							<MessageSquarePlus className="size-3.5" />
						</QuietIconButton>
					</TooltipTrigger>
					<TooltipContent>{t("pdfExplain.addToSidebarChat")}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<QuietIconButton
							tone="destructive"
							aria-label={t("annotations.delete")}
							onClick={(e) => {
								e.stopPropagation();
								cancelledRef.current = true;
								onDelete(item);
							}}
						>
							<Trash2 className="size-3.5" />
						</QuietIconButton>
					</TooltipTrigger>
					<TooltipContent>{t("annotations.delete")}</TooltipContent>
				</Tooltip>
			</div>
		</div>
	);
});

type SelectionCommentAffordanceProps = {
	inset?: boolean;
	draft: SelectionCommentDraft;
	pageHeightPx: number;
	onCommit: (comment: string) => void;
	onActiveChange?: (active: boolean) => void;
	/** Dismiss the sticky draft (Escape with empty text). */
	onDismiss?: () => void;
};

/** Selection note editor opened explicitly from the floating toolbar. */
const SelectionCommentAffordance = memo(function SelectionCommentAffordance({
	inset,
	draft,
	pageHeightPx,
	onCommit,
	onActiveChange,
	onDismiss,
}: SelectionCommentAffordanceProps) {
	const { t } = useTranslation("viewer");
	const rootRef = useRef<HTMLDivElement>(null);
	const editorHandleRef = useRef<CommentMarkdownEditorHandle | null>(null);
	const committedRef = useRef(false);
	const onCommitRef = useRef(onCommit);
	onCommitRef.current = onCommit;
	const onActiveChangeRef = useRef(onActiveChange);
	onActiveChangeRef.current = onActiveChange;
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;
	const aliveRef = useRef(true);
	const closingRef = useRef(false);
	const { isBlockedByIme } = useImeGuard();
	const kind = draft.visualRegion ? "visual" : "highlight";

	// The card hugs the editor; this estimate only keeps the anchor inside
	// the page while the draft is short.
	const clampHeightPx = estimateCommentCardHeight(
		{
			id: "__selection-draft__",
			pageIndex: draft.page - 1,
			anchorY: draft.anchorY,
			rects: [],
			quote: draft.quote,
			comment: "",
			color: DEFAULT_HIGHLIGHT_COLOR,
			kind,
			linkAlias: null,
		},
		true,
	);
	const topPx = Math.max(
		0,
		Math.min(draft.anchorY * pageHeightPx, pageHeightPx - clampHeightPx),
	);

	const commit = useCallback((text: string) => {
		if (committedRef.current) return;
		const trimmed = text.trim();
		if (!trimmed) return;
		committedRef.current = true;
		closingRef.current = true;
		onActiveChangeRef.current?.(false);
		onCommitRef.current(trimmed);
	}, []);

	// Keep the latest serialized draft for blur / click-away commits.
	const draftRef = useRef("");
	const readDraft = useCallback(
		() => editorHandleRef.current?.getMarkdown() ?? draftRef.current,
		[],
	);

	useEffect(() => {
		aliveRef.current = true;
		onActiveChangeRef.current?.(true);
		return () => {
			aliveRef.current = false;
			onActiveChangeRef.current?.(false);
		};
	}, []);

	// Clicking outside the note (e.g. anywhere on the PDF page) commits typed
	// text or drops an empty draft. Chrome elements (like the selection toolbar)
	// do not trigger dismissal.
	useEffect(() => {
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (
				!(target instanceof Node) ||
				rootRef.current?.contains(target) ||
				editorHandleRef.current?.ownsEquationPopover(target)
			) {
				return;
			}
			if ((target as Element).closest?.("[data-pdf-chrome]")) {
				return;
			}
			const text = readDraft().trim();
			closingRef.current = true;
			if (text) {
				commit(text);
			} else {
				onDismissRef.current?.();
			}
			editorHandleRef.current?.blur();
		};
		document.addEventListener("pointerdown", onPointerDown, true);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown, true);
		};
	}, [commit, readDraft]);

	return (
		// biome-ignore lint/a11y/useSemanticElements: hosts the note editor; native <button> cannot wrap it
		<div
			ref={rootRef}
			role="group"
			aria-label={t("selection.note")}
			data-pdf-chrome
			data-selection-comment=""
			data-comment-card
			className={cn(
				COMMENT_DRAFT_SURFACE_CLASS,
				"z-[7] w-56 bg-background/92 ring-1 ring-ring",
			)}
			style={{
				...(inset
					? { right: COMMENT_CARD_GAP_PX }
					: { left: `calc(100% + ${COMMENT_CARD_GAP_PX}px)` }),
				top: topPx,
			}}
			onPointerDown={(e) => {
				// Page-local hit: stop EmbedPDF from treating this as click-away
				// before the editor can take focus. Do not preventDefault.
				e.stopPropagation();
			}}
		>
			<div className="w-56 px-2.5 py-2">
				<MarkerGlyph
					kind={kind}
					color={DEFAULT_HIGHLIGHT_COLOR}
					shape={draft.shape}
				/>
				<CommentMarkdownEditor
					initialValue=""
					placeholder={t("annotations.placeholder")}
					ariaLabel={t("annotations.editorLabel")}
					className="comment-md mt-1 min-h-15 max-h-60 w-full overflow-y-auto break-words text-sm leading-relaxed text-foreground/80"
					handleRef={editorHandleRef}
					onChange={(markdown) => {
						draftRef.current = markdown;
					}}
					onBlur={(e) => {
						if (!aliveRef.current || closingRef.current) return;
						const next = e.relatedTarget as Node | null;
						if (
							next &&
							(rootRef.current?.contains(next) ||
								editorHandleRef.current?.ownsEquationPopover(next))
						)
							return;
						const active = document.activeElement;
						if (
							rootRef.current?.contains(active) ||
							editorHandleRef.current?.ownsEquationPopover(active)
						) {
							return;
						}
						const text = readDraft();
						if (text.trim()) {
							commit(text);
							return;
						}
						closingRef.current = true;
						onDismissRef.current?.();
					}}
					onFocus={() => {
						onActiveChangeRef.current?.(true);
					}}
					onKeyDown={(e) => {
						e.stopPropagation();
						if (e.key === "Escape") {
							e.preventDefault();
							closingRef.current = true;
							onActiveChangeRef.current?.(false);
							onDismissRef.current?.();
							return;
						}
						if (
							e.key === "Enter" &&
							(e.metaKey || e.ctrlKey) &&
							!isBlockedByIme(e)
						) {
							e.preventDefault();
							commit(readDraft());
						}
					}}
				/>
			</div>
		</div>
	);
});

export const CommentCardsLayer = memo(function CommentCardsLayer({
	inset = false,
	items,
	pageWidthPx,
	pageHeightPx,
	editingId,
	wikiTarget,
	hoveredId,
	selectionDraft = null,
	onCommitSelectionComment,
	onSelectionCommentActiveChange,
	onDismissSelectionComment,
	onOpen,
	onSave,
	onCancel,
	onDelete,
	onCopyLink,
	onCopyEmbed,
	onAddToChat,
	onHover,
	onLeave,
}: CommentCardsLayerProps) {
	const [retainedHoverId, setRetainedHoverId] = useState<string | null>(null);
	const [measuredHeights, setMeasuredHeights] = useState<
		ReadonlyMap<string, number>
	>(() => new Map());
	const handleMeasure = useCallback((id: string, heightPx: number) => {
		setMeasuredHeights((prev) => {
			if (prev.get(id) === heightPx) return prev;
			const next = new Map(prev);
			next.set(id, heightPx);
			return next;
		});
	}, []);
	// Cap card height to the reading viewport so a short window / pane scrolls
	// the card body instead of clipping it against the chrome around it.
	const rootRef = useRef<HTMLDivElement>(null);
	const [viewportHeight, setViewportHeight] = useState<number | null>(null);
	const hasCards = items.length > 0 || Boolean(selectionDraft);
	useLayoutEffect(() => {
		if (!hasCards) return;
		const el = rootRef.current;
		if (!el) return;
		const scroller = el.closest("[data-pdf-viewport]");
		if (!scroller) return;
		const measure = () => setViewportHeight(scroller.clientHeight);
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(scroller);
		return () => observer.disconnect();
	}, [hasCards]);
	const cardMaxHeightPx = Math.max(
		COMMENT_CARD_MIN_HEIGHT_PX,
		Math.min(
			COMMENT_CARD_MAX_HEIGHT_PX,
			(viewportHeight ?? Number.POSITIVE_INFINITY) -
				COMMENT_VIEWPORT_MARGIN_PX * 2,
		),
	);
	useEffect(() => {
		if (!inset) return;
		if (hoveredId) {
			setRetainedHoverId(hoveredId);
			return;
		}
		// Let the pointer travel from the source highlight into the inset card.
		// The card sits at the page's right edge, so a left-column highlight is
		// a long trip; too short a window makes the card vanish on the way.
		const timer = setTimeout(() => setRetainedHoverId(null), 500);
		return () => clearTimeout(timer);
	}, [inset, hoveredId]);
	// Stacking depends only on items / page height / the edited card; hover
	// re-renders (hoveredId flips) must not redo layout for the whole rail.
	const laid = useMemo(
		() =>
			layoutCommentCards(
				items,
				pageHeightPx,
				editingId,
				measuredHeights,
				cardMaxHeightPx,
			),
		[items, pageHeightPx, editingId, measuredHeights, cardMaxHeightPx],
	);
	const byId = useMemo(
		() => new Map(items.map((item) => [item.id, item])),
		[items],
	);
	if (!items.length && !selectionDraft) return null;
	const hoveredPlacement = hoveredId
		? (laid.find((pos) => pos.id === hoveredId) ?? null)
		: null;
	const hoveredItem = hoveredId ? (byId.get(hoveredId) ?? null) : null;
	const connectorD =
		!inset && hoveredItem && hoveredPlacement
			? commentConnectorPath(
					hoveredItem.rects,
					hoveredPlacement,
					pageWidthPx,
					pageHeightPx,
				)
			: null;
	const svgWidth = pageWidthPx + COMMENT_CARD_GAP_PX + COMMENT_CARD_WIDTH_PX;

	return (
		// Above translated glyphs (also z-6, mounted earlier) so the rail stays visible.
		<div
			ref={rootRef}
			className="pointer-events-none absolute top-0 left-0 z-[6] overflow-visible"
			style={{
				width: pageWidthPx,
				height: pageHeightPx,
			}}
		>
			{connectorD ? (
				// Decorative hover leader; announced via the card / hit-target labels.
				// biome-ignore lint/a11y/noSvgWithoutTitle: purely visual connector
				<svg
					aria-hidden
					focusable="false"
					className="pointer-events-none absolute top-0 left-0 overflow-visible"
					width={svgWidth}
					height={pageHeightPx}
					viewBox={`0 0 ${svgWidth} ${pageHeightPx}`}
				>
					<path
						d={connectorD}
						fill="none"
						className="stroke-background/95 dark:stroke-background/90"
						strokeWidth={5}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
					<path
						d={connectorD}
						fill="none"
						className="stroke-foreground/60"
						strokeWidth={2.5}
						strokeLinecap="round"
						strokeLinejoin="round"
					/>
				</svg>
			) : null}
			<TooltipProvider delayDuration={200}>
				{laid.map((pos) => {
					const item = byId.get(pos.id);
					if (!item) return null;
					if (
						inset &&
						item.id !== editingId &&
						item.id !== hoveredId &&
						item.id !== retainedHoverId &&
						!item.isNew
					)
						return null;
					return (
						<CommentCard
							inset={inset}
							key={item.id}
							item={item}
							topPx={pos.topPx}
							maxHeightPx={pos.heightPx}
							editing={item.id === editingId}
							wikiTarget={wikiTarget}
							hovered={item.id === hoveredId}
							onMeasure={handleMeasure}
							onOpen={onOpen}
							onSave={onSave}
							onCancel={onCancel}
							onDelete={onDelete}
							onCopyLink={onCopyLink}
							onCopyEmbed={onCopyEmbed}
							onAddToChat={onAddToChat}
							onHover={onHover}
							onLeave={onLeave}
						/>
					);
				})}
				{selectionDraft && onCommitSelectionComment ? (
					<SelectionCommentAffordance
						inset={inset}
						draft={selectionDraft}
						pageHeightPx={pageHeightPx}
						onCommit={onCommitSelectionComment}
						onActiveChange={onSelectionCommentActiveChange}
						onDismiss={onDismissSelectionComment}
					/>
				) : null}
			</TooltipProvider>
		</div>
	);
});
