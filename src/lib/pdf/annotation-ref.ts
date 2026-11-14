/**
 * Resolve a paper-local annotation / visual-trace id for wiki `[[target@id]]`
 * links and `![[…]]` embeds.
 *
 * Sources (MVP):
 * - highlights / text notes: `marks/annotations.json` (EmbedPDF transfer)
 * - visual marks: `marks/<id>.json` with `kind: "visual"` (legacy `agent-trace`)
 *
 * Marks are stored under the paper folder. UI state is often keyed by the PDF
 * tab id (`tabIdForPath(paperAbs)`), which differs from the NOTES companion
 * tab — always resolve through the paper folder, not only the active tab id.
 */

import type { PdfAnnotationObject } from "@embedpdf/models";
import { paperDirFromPath } from "@/lib/paper/detect";
import { loadPdfVisualTraceImage } from "@/lib/pdf/agent-trace/image";
import { listPdfVisualTraces } from "@/lib/pdf/agent-trace/io";
import {
	parsePdfVisualSessionTrace,
	traceMessagesForEmbed,
} from "@/lib/pdf/agent-trace/schema";
import type {
	PdfVisualTraceImage,
	PdfVisualTraceMessage,
} from "@/lib/pdf/agent-trace/types";
import {
	highlightColorOf,
	highlightQuoteOf,
	highlightViewFromObject,
	isTextMarkupObject,
	loadAnnotationItems,
	textMarkupKindOf,
} from "@/lib/pdf/highlight/annotation-store";
import type { HighlightColor } from "@/lib/pdf/highlight/palette";
import type { PdfTextMarkupKind } from "@/lib/pdf/highlight/types";
import { normalizeSentenceKey } from "@/lib/pdf/layout/layout-sentences";
import { readMarkRaw } from "@/lib/pdf/selection/marks-io";
import type { PdfVisualNormalizedRect } from "@/lib/pdf-visual/types";
import { joinVaultPath } from "@/lib/vault";
import { formatWikiLinkBody } from "@/lib/wiki/api";
import { tabIdForPath } from "@/lib/workspace/tabs/model";

export type AnnotationRefKind = "highlight" | "visual" | "agent-trace";

export type AnnotationRefRect = {
	/** 0–1 relative to page box (top-down when from app marks). */
	x: number;
	y: number;
	w: number;
	h: number;
};

export type AnnotationRef = {
	kind: AnnotationRefKind;
	id: string;
	/** Absolute paper directory when known. */
	paperAbsPath: string;
	/** 1-based page. */
	page: number;
	/** Highlighted quote (highlights) or empty. */
	quote: string;
	/** User comment / visual-trace comment. */
	comment: string;
	color?: HighlightColor;
	/** Text-markup shape; highlights / legacy refs default to `highlight`. */
	shape?: PdfTextMarkupKind;
	/** Optional crop preview for visual traces. */
	image?: PdfVisualTraceImage;
	/** Normalized rects when known (for outline y matching). */
	rects?: AnnotationRefRect[];
	/** Visual-trace multi-turn transcript (read-only embed). */
	messages?: PdfVisualTraceMessage[];
};

/** Min y of rects (0–1), for outline location. */
export function annotationAnchorY(
	rects: AnnotationRefRect[] | undefined,
): number | undefined {
	if (!rects?.length) return undefined;
	let min = Number.POSITIVE_INFINITY;
	for (const r of rects) {
		if (Number.isFinite(r.y)) min = Math.min(min, r.y);
	}
	return Number.isFinite(min) ? min : undefined;
}

function rectsFromHighlightObject(annotation: object): AnnotationRefRect[] {
	const obj = annotation as {
		segmentRects?: Array<{
			origin?: { x?: number; y?: number };
			size?: { width?: number; height?: number };
		}>;
		rect?: {
			origin?: { x?: number; y?: number };
			size?: { width?: number; height?: number };
		};
	};
	const segs = obj.segmentRects?.length
		? obj.segmentRects
		: obj.rect
			? [obj.rect]
			: [];
	// EmbedPDF rects are in PDF page points — we only need relative y order for
	// same-page outline ties; store raw points normalized by a fake page height
	// is wrong. Prefer leaving rects empty for highlights unless we have 0–1.
	// Visual traces already store 0–1 rects on disk.
	void segs;
	return [];
}

function rectsFromVisual(
	rects: PdfVisualNormalizedRect[],
): AnnotationRefRect[] {
	return rects.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h }));
}

/** One list row for panels / `@` completion (disk or memory). */
export type PaperAnnotationSummary = {
	kind: AnnotationRefKind;
	id: string;
	page: number;
	quote: string;
	comment: string;
	color?: HighlightColor;
	/** Short text for alias / candidate label (already truncated). */
	preview: string;
};

/** Default max length for wikilink alias / completion labels. */
export const ANNOTATION_PREVIEW_MAX = 36;

/** Collapse whitespace and truncate for alias/candidate display. */
export function truncateAnnotationPreview(
	text: string,
	max = ANNOTATION_PREVIEW_MAX,
): string {
	const compact = text.replace(/\s+/g, " ").trim();
	if (!compact) return "";
	if (compact.length <= max) return compact;
	if (max <= 1) return "…";
	return `${compact.slice(0, Math.max(1, max - 1))}…`;
}

/**
 * Display alias: `Paper Title·truncated note`.
 * Falls back to preview-only or title-only when one side is empty.
 */
export function annotationWikilinkAlias(
	paperTitle: string | null | undefined,
	snippet: string | null | undefined,
	maxSnippet = ANNOTATION_PREVIEW_MAX,
): string | undefined {
	const title = paperTitle?.replace(/\s+/g, " ").trim() || "";
	const preview = truncateAnnotationPreview(snippet ?? "", maxSnippet);
	if (title && preview) return `${title}·${preview}`;
	if (title) return title;
	if (preview) return preview;
	return undefined;
}

/** Prefer comment, else quote, for alias/list preview body. */
export function annotationSnippet(input: {
	comment?: string | null;
	quote?: string | null;
}): string {
	return (input.comment?.trim() || input.quote?.trim() || "").trim();
}

function transferItemId(item: unknown): string | null {
	if (!item || typeof item !== "object") return null;
	const annotation = (item as { annotation?: unknown }).annotation;
	if (annotation && typeof annotation === "object") {
		const id = (annotation as { id?: unknown }).id;
		if (typeof id === "string" && id) return id;
	}
	const id = (item as { id?: unknown }).id;
	return typeof id === "string" && id ? id : null;
}

/**
 * Highlight color for a composer reference. A saved annotation id wins; otherwise
 * the quote (and page, when given) matches the note on disk.
 */
export function highlightColorFromItems(
	items: readonly unknown[],
	query: { id?: string; quote?: string; page?: number },
): HighlightColor | null {
	const quoteKey = query.quote ? normalizeSentenceKey(query.quote) : "";
	let quoteMatch: HighlightColor | null = null;
	for (const item of items) {
		if (!item || typeof item !== "object") continue;
		const annotation = (item as { annotation?: unknown }).annotation;
		if (!annotation || typeof annotation !== "object") continue;
		if (!isTextMarkupObject(annotation as PdfAnnotationObject)) continue;
		const color = highlightColorOf(
			annotation as Parameters<typeof highlightColorOf>[0],
		);
		const id = (annotation as { id?: string }).id;
		if (query.id && id === query.id) return color;
		if (!quoteKey) continue;
		const stored = highlightQuoteOf(
			annotation as Parameters<typeof highlightQuoteOf>[0],
		);
		if (normalizeSentenceKey(stored) !== quoteKey) continue;
		const page = ((annotation as { pageIndex?: number }).pageIndex ?? 0) + 1;
		if (query.page != null && page !== query.page) continue;
		quoteMatch = color;
	}
	return quoteMatch;
}

export async function lookupHighlightColor(
	paperAbsPath: string,
	query: { id?: string; quote?: string; page?: number },
): Promise<HighlightColor | null> {
	if (!paperAbsPath) return null;
	if (!query.id && !query.quote?.trim()) return null;
	const items = await loadAnnotationItems(paperAbsPath);
	return highlightColorFromItems(items, query);
}

/** Look up one id under a paper folder (highlight or visual-trace). */
export async function lookupAnnotationRef(
	paperAbsPath: string,
	id: string,
	options?: { includeImage?: boolean },
): Promise<AnnotationRef | null> {
	if (!paperAbsPath || !id) return null;

	const items = await loadAnnotationItems(paperAbsPath);
	for (const item of items) {
		const annotation = (item as { annotation?: unknown }).annotation;
		if (!annotation || typeof annotation !== "object") continue;
		const obj = annotation as {
			id?: string;
			pageIndex?: number;
			contents?: string;
		};
		if (obj.id !== id) continue;
		if (isTextMarkupObject(annotation as never)) {
			const hl = annotation as Parameters<typeof highlightQuoteOf>[0];
			const comment = obj.contents?.trim() ?? "";
			const rects = rectsFromHighlightObject(annotation);
			return {
				kind: "highlight",
				id,
				paperAbsPath,
				page: (obj.pageIndex ?? 0) + 1,
				quote: highlightQuoteOf(hl),
				comment,
				color: highlightColorOf(hl),
				shape: textMarkupKindOf(hl),
				...(rects.length ? { rects } : {}),
			};
		}
		// Non-highlight annotation objects still jump by id if present.
		return {
			kind: "highlight",
			id,
			paperAbsPath,
			page: (obj.pageIndex ?? 0) + 1,
			quote: "",
			comment: obj.contents?.trim() ?? "",
		};
	}

	const raw = await readMarkRaw(paperAbsPath, id);
	const trace = parsePdfVisualSessionTrace(raw);
	if (trace && trace.id === id) {
		// Embed: note field vs conversation are separate; do not promote comment
		// into a synthetic "user" turn (see traceMessagesForEmbed).
		const messages = traceMessagesForEmbed(trace);
		const image = options?.includeImage
			? await loadPdfVisualTraceImage(paperAbsPath, trace.image)
			: null;
		return {
			kind: "visual",
			id,
			paperAbsPath,
			page: trace.page,
			quote: "",
			comment: trace.comment,
			...(image ? { image } : {}),
			rects: rectsFromVisual(trace.rects),
			...(messages.length ? { messages } : {}),
		};
	}

	// Id present in transfer under a different shape (id at top-level only).
	if (items.some((item) => transferItemId(item) === id)) {
		return {
			kind: "highlight",
			id,
			paperAbsPath,
			page: 1,
			quote: "",
			comment: "",
		};
	}

	return null;
}

/**
 * Resolvable wiki target for a paper unit — never the display title alone.
 *
 * Prefer vault-relative `…/NOTES` (indexed Markdown). Fallbacks: paper folder
 * basename (stem match against NOTES/PDF) or a PDF path when known.
 */
export function wikiTargetForPaper(
	paperAbsPath: string,
	paperRelPath?: string | null,
): string {
	const rel = (paperRelPath ?? paperAbsPath)
		.replace(/\\/g, "/")
		.replace(/\/+$/, "");
	const parts = rel.split("/").filter(Boolean);
	const last = parts[parts.length - 1] ?? rel;
	if (last.toLowerCase() === "notes.md") {
		// papers/foo/NOTES.md → papers/foo/NOTES (extension optional for resolve)
		const without = rel.replace(/\/NOTES\.md$/i, "/NOTES");
		return without.replace(/^\//, "");
	}
	if (/\.pdf$/i.test(last)) {
		return rel.replace(/^\//, "");
	}
	// Paper folder vault-rel → NOTES target (most stable across renames of PDF name)
	if (parts[0]?.toLowerCase() === "papers" || rel.includes("/papers/")) {
		return `${rel.replace(/^\//, "")}/NOTES`;
	}
	return last.replace(/\.(md|mdx|markdown|pdf)$/i, "") || last;
}

/**
 * Prefer a target that wiki resolve can open; optional alias is display-only
 * (paper title). Same-note form is `[[@id]]` when `sameNote` is true.
 */
export function annotationWikilinkMarkdown(input: {
	target: string;
	id: string;
	embed?: boolean;
	alias?: string;
	/** When true, omit target → `[[@id]]` (current NOTES / paper). */
	sameNote?: boolean;
}): string {
	const body = formatWikiLinkBody(
		input.sameNote ? "" : input.target,
		{ kind: "annotation", id: input.id },
		input.alias,
	);
	return `${input.embed ? "!" : ""}[[${body}]]`;
}

/**
 * Derive paper absolute dir from a resolved vault-relative wiki target path
 * (NOTES.md, PDF, or paper folder path).
 * Preserves the vault root's separator style (Windows backslash roots stay
 * native so subsequent fs opens do not hit ERROR_INVALID_NAME).
 */
export function paperAbsFromWikiTarget(
	vaultPath: string,
	targetPath: string,
): string {
	const rel = targetPath.replace(/\\/g, "/").replace(/^\/+/, "");
	const full = joinVaultPath(vaultPath, rel);
	const useBackslash = full.includes("\\");
	const asPosix = full.replace(/\\/g, "/");
	let paperPosix = asPosix;
	if (/\/NOTES\.md$/i.test(asPosix)) {
		paperPosix = asPosix.replace(/\/NOTES\.md$/i, "");
	} else if (/\/NOTES$/i.test(asPosix)) {
		// Stem-only NOTES resolve target: papers/foo/NOTES
		paperPosix = asPosix.replace(/\/NOTES$/i, "");
	} else if (/\.pdf$/i.test(asPosix)) {
		const idx = asPosix.lastIndexOf("/");
		paperPosix = idx >= 0 ? asPosix.slice(0, idx) : asPosix;
	} else {
		paperPosix = asPosix.replace(/\/+$/, "");
	}
	return useBackslash ? paperPosix.replace(/\//g, "\\") : paperPosix;
}

/**
 * Absolute paper directory for an open workspace tab (PDF body or NOTES companion).
 */
export function paperAbsFromWorkspaceTab(
	tab: {
		path: string;
		notesPath?: string | null;
		paperMeta?: { path?: string | null } | null;
		mode?: string;
		kind?: string;
	} | null,
	vaultPath: string | null,
	paperFolders?: string[] | null,
): string | null {
	if (!tab) return null;
	const root = vaultPath?.replace(/[\\/]+$/, "") ?? "";
	if (tab.paperMeta?.path && root) {
		return joinVaultPath(root, tab.paperMeta.path.replace(/\\/g, "/"));
	}
	if (tab.notesPath) {
		return tab.notesPath.replace(/\\/g, "/").replace(/\/NOTES\.md$/i, "");
	}
	const path = tab.path.replace(/\\/g, "/");
	if (/\/NOTES\.md$/i.test(path)) {
		return path.replace(/\/NOTES\.md$/i, "");
	}
	const fromTree = paperDirFromPath(path, paperFolders);
	if (fromTree) return fromTree;
	if (tab.mode === "pdf" || tab.kind === "paper") {
		return path.replace(/\/+$/, "");
	}
	return null;
}

/** PDF body tab id for a paper folder (where highlight store + viewer handle live). */
export function pdfTabIdForPaper(paperAbsPath: string): string {
	return tabIdForPath(paperAbsPath.replace(/\\/g, "/").replace(/\/+$/, ""));
}

/** Absolute paper dir from the NOTES/markdown source file being edited. */
export function paperAbsFromSourceFile(
	sourceAbsPath: string | null | undefined,
	paperFolders?: string[] | null,
): string | null {
	if (!sourceAbsPath) return null;
	const path = sourceAbsPath.replace(/\\/g, "/");
	if (/\/NOTES\.md$/i.test(path)) {
		return path.replace(/\/NOTES\.md$/i, "");
	}
	return paperDirFromPath(path, paperFolders);
}

/**
 * Load all linkable marks for a paper from disk (not the in-memory PDF tab store).
 * Use when the NOTES companion is focused and the PDF tab store is empty/unmounted.
 */
export async function listPaperAnnotationSummaries(
	paperAbsPath: string,
): Promise<PaperAnnotationSummary[]> {
	if (!paperAbsPath) return [];
	const out: PaperAnnotationSummary[] = [];
	const items = await loadAnnotationItems(paperAbsPath);
	for (const item of items) {
		const annotation = (item as { annotation?: unknown }).annotation;
		if (!annotation || typeof annotation !== "object") continue;
		if (!isTextMarkupObject(annotation as never)) continue;
		const view = highlightViewFromObject(
			annotation as Parameters<typeof highlightViewFromObject>[0],
			paperAbsPath,
		);
		const snippet = annotationSnippet({
			comment: view.comment,
			quote: view.quote,
		});
		out.push({
			kind: "highlight",
			id: view.id,
			page: view.page,
			quote: view.quote,
			comment: view.comment ?? "",
			color: view.color as HighlightColor | undefined,
			preview: truncateAnnotationPreview(snippet) || view.id,
		});
	}
	const traces = await listPdfVisualTraces(paperAbsPath);
	for (const trace of traces) {
		const snippet = annotationSnippet({ comment: trace.comment });
		out.push({
			kind: "visual",
			id: trace.id,
			page: trace.page,
			quote: "",
			comment: trace.comment,
			preview: truncateAnnotationPreview(snippet) || trace.id,
		});
	}
	out.sort((a, b) => a.page - b.page || a.id.localeCompare(b.id));
	return out;
}
