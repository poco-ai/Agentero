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
 * panes scroll the card body instead of clipping it.
 */

import { Crop, Link2, MessageSquarePlus, Trash2 } from "lucide-react";
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
	"group pointer-events-auto absolute flex flex-col select-none rounded-lg border border-white/55 bg-background/88 shadow-overlay ring-1 ring-foreground/10 backdrop-blur-xl backdrop-saturate-150 transition-[box-shadow,background-color,transform] duration-150 ease-out hover:z-[7] supports-backdrop-blur:bg-background/70 dark:border-white/10";
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

/**
 * Anchor each card at its highlight height, then nudge overlapping cards
 * downward (never sideways) and clamp the whole stack into the page height.
 * Measured card heights override the estimates when provided.
 */
export function layoutCommentCards(
	items: PageAnnotationComment[],
	pageHeightPx: number,
	editingId?: string | null,
	measuredHeights?: ReadonlyMap<string, number>,
): CommentCardPlacement[] {
	const sorted = [...items].sort(
		(a, b) => a.anchorY - b.anchorY || a.id.localeCompare(b.id),
	);
	const laid: CommentCardPlacement[] = [];

	for (const item of sorted) {
		const heightPx =
			measuredHeights?.get(item.id) ??
			estimateCommentCardHeight(item, item.id === editingId);
		const anchorTop = item.anchorY * pageHeightPx;
		const prev = laid[laid.length - 1];
		const topPx = Math.max(
			anchorTop,
			prev ? prev.topPx + prev.heightPx + CARD_GAP_PX : 0,
		);
		laid.push({ id: item.id, topPx, heightPx });
	}

	// Clamp the stack into the page: shift cards up bottom-first, keeping the
	// avoidance gap between neighbours.
	for (let i = laid.length - 1; i >= 0; i -= 1) {
		const card = laid[i];
		const next = laid[i + 1];
		const maxTop = next
			? next.topPx - CARD_GAP_PX - card.heightPx
			: pageHeightPx - card.heightPx;
		card.topPx = Math.max(0, Math.min(card.topPx, maxTop));
	}

	return laid;
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
	/** Height cap: content cap clamped by the reading-viewport height. */
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

	// Report the rendered height (border-box) so the rail stacks against real
	// card sizes instead of the layout seed estimate.
	useLayoutEffect(() => {
		const el = rootRef.current;
		if (!el) return;
		let last = -1;
		const report = () => {
			const height = el.offsetHeight;
			if (height > 0 && height !== last) {
				last = height;
				onMeasure(item.id, height);
			}
		};
		report();
		const observer = new ResizeObserver(report);
		observer.observe(el);
		return () => observer.disconnect();
	}, [item.id, onMeasure]);

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
			if (!target || rootRef.current?.contains(target)) return;
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
				COMMENT_CARD_SURFACE_CLASS,
				editing
					? "z-[6] bg-background/92 ring-2 ring-ring/50"
					: hovered
						? "z-[6] bg-background/92 ring-2 ring-primary/45"
						: "",
			)}
			style={{
				...(inset
					? { right: COMMENT_CARD_GAP_PX }
					: { left: `calc(100% + ${COMMENT_CARD_GAP_PX}px)` }),
				top: topPx,
				width: COMMENT_CARD_WIDTH_PX,
				maxHeight: maxHeightPx,
			}}
			onPointerEnter={() => onHover(item)}
			onPointerLeave={onLeave}
		>
			{/* biome-ignore lint/a11y/noStaticElementInteractions: blur/pointer isolation for the in-place editor */}
			<div
				className="agentero-scroll min-h-0 w-full flex-1 overflow-auto rounded-[inherit] px-2.5 py-2 text-left"
				onPointerDown={(e) => e.stopPropagation()}
				onBlur={
					editing
						? (e) => {
								const next = e.relatedTarget as Node | null;
								if (
									next &&
									(e.currentTarget.contains(next) ||
										rootRef.current?.contains(next))
								) {
									return;
								}
								// Ignore the view→edit swap: WebKit queues a focusout
								// when the focused view body unmounts. It is not a
								// click-away until the editable has focus and focus has
								// actually left the card.
								if (!editorFocusedRef.current) return;
								if (rootRef.current?.contains(document.activeElement)) return;
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
						{item.kind === "visual" ? (
							<Crop className="size-2.5 text-muted-foreground" aria-hidden />
						) : (
							<span
								className={cn(
									"block size-2 rounded-full",
									swatchColorClass(item.color),
								)}
								aria-hidden
							/>
						)}
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
						className="block w-full cursor-text text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
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
						{item.kind === "visual" ? (
							<Crop className="size-2.5 text-muted-foreground" aria-hidden />
						) : (
							<span
								className={cn(
									"block size-2 rounded-full",
									swatchColorClass(item.color),
								)}
								aria-hidden
							/>
						)}
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
			kind: "highlight",
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
			if (!(target instanceof Node) || rootRef.current?.contains(target)) {
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
				"z-[7] w-56 bg-background/92 ring-2 ring-ring/50",
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
				<span
					className={cn(
						"block size-2 rounded-full",
						swatchColorClass(DEFAULT_HIGHLIGHT_COLOR),
					)}
					aria-hidden
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
						if (next && rootRef.current?.contains(next)) return;
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
		() => layoutCommentCards(items, pageHeightPx, editingId, measuredHeights),
		[items, pageHeightPx, editingId, measuredHeights],
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
							maxHeightPx={cardMaxHeightPx}
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
