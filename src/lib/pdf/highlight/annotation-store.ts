import type { PdfAnnotationObject } from "@embedpdf/models";
import { PdfAnnotationSubtype } from "@embedpdf/models";
import type { TrackedAnnotation } from "@embedpdf/plugin-annotation";
import type { AnnotationTransferItem } from "@embedpdf/plugin-annotation/react";
import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";
import {
	dedupeAnnotationItems,
	reviveAnnotationDates,
} from "@/lib/pdf/highlight/annotation-items";
import {
	type HighlightColor,
	highlightColorFromHex,
} from "@/lib/pdf/highlight/palette";
import { sanitizeTranslatedRects } from "@/lib/pdf/highlight/translated-geometry";
import type {
	PdfHighlight,
	PdfTextMarkupAnnoObject,
	PdfTextMarkupKind,
} from "@/lib/pdf/highlight/types";
import {
	ANNOTATIONS_JSON,
	MARKS_FOLDER,
	markSelfWrite,
} from "@/lib/pdf/selection/marks-io";
import {
	isPathMissingError,
	joinVaultPath,
	readVaultFile,
	vaultRelativePath,
	writeVaultFile,
} from "@/lib/vault";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";

/**
 * Highlights/批注 are stored as EmbedPDF annotations (source of truth) in
 * `papers/<id>/marks/annotations.json` — the `exportAnnotations()` /
 * `importAnnotations()` transfer format. Ask/Translate stay as sibling
 * `marks/<id>.json` files. A legacy root-level `papers/<id>/annotations.json`
 * is migrated into `marks/` on first load.
 */
export const ANNOTATIONS_FILE = ANNOTATIONS_JSON;

/** In-memory fallback when not running under Tauri (browser dev). */
const memoryStore = new Map<string, AnnotationTransferItem[]>();

/** Canonical path: `papers/<id>/marks/annotations.json`. */
function annotationsPath(paperAbsPath: string): string {
	return joinVaultPath(
		joinVaultPath(paperAbsPath, MARKS_FOLDER),
		ANNOTATIONS_FILE,
	);
}

/** Pre-move path: `papers/<id>/annotations.json` (paper root). */
function legacyAnnotationsPath(paperAbsPath: string): string {
	return joinVaultPath(paperAbsPath, ANNOTATIONS_FILE);
}

async function removeFileIfExists(path: string): Promise<void> {
	try {
		const { remove } = await import("@tauri-apps/plugin-fs");
		await remove(path);
	} catch {
		// missing is fine
	}
}

function parseAnnotationItems(raw: string): AnnotationTransferItem[] {
	const parsed = JSON.parse(raw) as unknown;
	if (!Array.isArray(parsed)) return [];
	return dedupeAnnotationItems(
		(parsed as AnnotationTransferItem[]).map(reviveAnnotationDates),
	);
}

export async function readAnnotationSnapshot(paperAbsPath: string): Promise<{
	raw: string | null;
	items: AnnotationTransferItem[];
	legacy?: boolean;
}> {
	if (!isTauri())
		return { raw: null, items: memoryStore.get(paperAbsPath) ?? [] };
	for (const path of [
		annotationsPath(paperAbsPath),
		legacyAnnotationsPath(paperAbsPath),
	]) {
		let raw: string;
		try {
			raw = await readVaultFile(path);
		} catch (error) {
			if (isPathMissingError(error)) continue;
			throw error;
		}
		const items: unknown = JSON.parse(raw);
		if (
			!Array.isArray(items) ||
			items.some(
				(item) => !item?.annotation || typeof item.annotation !== "object",
			)
		) {
			throw new Error("Invalid PDF annotations file");
		}
		return {
			raw,
			items: dedupeAnnotationItems(
				(items as AnnotationTransferItem[]).map(reviveAnnotationDates),
			),
			legacy: path === legacyAnnotationsPath(paperAbsPath),
		};
	}
	return { raw: null, items: [] };
}

export async function mergeAnnotationItems<Result>(
	paperAbsPath: string,
	merge: (current: AnnotationTransferItem[]) => {
		items: AnnotationTransferItem[];
		result: Result;
	},
	vault: string | null,
): Promise<Result> {
	const relative =
		vault && !isRemoteVaultHandle(vault)
			? vaultRelativePath(vault, paperAbsPath)
			: null;
	for (let attempt = 0; attempt < 4; attempt++) {
		const {
			raw,
			items: current,
			legacy,
		} = await readAnnotationSnapshot(paperAbsPath);
		const { items, result } = merge(current);
		if (items === current) return result;
		if (!isTauri() || !vault || !relative) {
			await saveAnnotationItems(paperAbsPath, items);
			return result;
		}
		const data = `${JSON.stringify(dedupeAnnotationItems(items), null, 2)}\n`;
		if (data === raw && !legacy) return result;
		markSelfWrite(annotationsPath(paperAbsPath));
		if (
			await callApi(() =>
				commands.pdfSaveAnnotations(vault, relative, raw, data),
			)
		)
			return result;
	}
	throw new Error("PDF annotations changed during save. Try again.");
}

export async function loadAnnotationItems(
	paperAbsPath: string,
	vaultPath: string | null = null,
): Promise<AnnotationTransferItem[]> {
	if (!paperAbsPath) return [];
	if (!isTauri()) {
		return dedupeAnnotationItems(memoryStore.get(paperAbsPath) ?? []);
	}

	// Prefer marks/; fall back to paper-root and migrate once.
	try {
		return parseAnnotationItems(
			await readVaultFile(annotationsPath(paperAbsPath)),
		);
	} catch {
		// continue to legacy
	}

	try {
		const items = parseAnnotationItems(
			await readVaultFile(legacyAnnotationsPath(paperAbsPath)),
		);
		return await mergeAnnotationItems(
			paperAbsPath,
			(current) => {
				const next = dedupeAnnotationItems([...current, ...items]);
				return { items: next, result: next };
			},
			vaultPath,
		);
	} catch {
		return [];
	}
}

export async function saveAnnotationItems(
	paperAbsPath: string,
	items: AnnotationTransferItem[],
): Promise<void> {
	if (!paperAbsPath) return;
	const next = dedupeAnnotationItems(items);
	if (!isTauri()) {
		memoryStore.set(paperAbsPath, next);
		return;
	}
	const path = annotationsPath(paperAbsPath);
	markSelfWrite(path);
	await writeVaultFile(path, `${JSON.stringify(next, null, 2)}\n`);
	// Drop legacy root copy if present so marks/ is the only location.
	await removeFileIfExists(legacyAnnotationsPath(paperAbsPath));
}

/** Text-markup annotations the reader creates and edits (highlight / underline). */
export function isTextMarkupObject(
	obj: PdfAnnotationObject,
): obj is PdfTextMarkupAnnoObject {
	return (
		obj.type === PdfAnnotationSubtype.HIGHLIGHT ||
		obj.type === PdfAnnotationSubtype.UNDERLINE
	);
}

/** Shape carried by a text-markup annotation object. */
export function textMarkupKindOf(
	obj: PdfTextMarkupAnnoObject,
): PdfTextMarkupKind {
	return obj.type === PdfAnnotationSubtype.UNDERLINE
		? "underline"
		: "highlight";
}

/**
 * EmbedPDF keeps a deleted annotation in `byUid` until an async commit purges
 * it, and `getAnnotations()` / `getAnnotationById()` still return it as
 * `commitState: "deleted"` in the meantime (or forever if the commit was
 * dropped). Rendering, hit testing and editors must treat those as gone.
 */
export function isLiveAnnotation(
	annotation: Pick<TrackedAnnotation, "commitState">,
): boolean {
	return annotation.commitState !== "deleted";
}

/** App-specific metadata round-tripped through the annotation `custom` field. */
export type HighlightCustom = {
	app?: string;
	paletteKey?: HighlightColor;
	quote?: string;
	/**
	 * Page-fraction boxes of the translated selection on this annotation's
	 * page. Absent for a highlight made on the English text layer.
	 */
	translatedRects?: PdfHighlight["translatedRects"];
};

export function highlightColorOf(obj: PdfTextMarkupAnnoObject): HighlightColor {
	const custom = (obj.custom ?? {}) as HighlightCustom;
	if (custom.paletteKey) return custom.paletteKey;
	return highlightColorFromHex(obj.strokeColor ?? obj.color);
}

export function highlightQuoteOf(obj: PdfTextMarkupAnnoObject): string {
	const custom = (obj.custom ?? {}) as HighlightCustom;
	return custom.quote?.trim() ?? "";
}

/** Build the PdfHighlight view model that the annotations panel + handle use. */
export function highlightViewFromObject(
	obj: PdfTextMarkupAnnoObject,
	paperPath: string,
): PdfHighlight {
	const iso = (d?: Date) =>
		d instanceof Date ? d.toISOString() : new Date().toISOString();
	const comment = obj.contents?.trim();
	const view: PdfHighlight = {
		version: 1,
		kind: textMarkupKindOf(obj),
		id: obj.id,
		paperPath,
		createdAt: iso(obj.created),
		updatedAt: iso(obj.modified ?? obj.created),
		page: obj.pageIndex + 1,
		rects: [],
		quote: highlightQuoteOf(obj),
		color: highlightColorOf(obj),
	};
	if (comment) view.comment = comment;
	const translated = sanitizeTranslatedRects(
		(obj.custom as HighlightCustom | undefined)?.translatedRects,
	);
	if (translated.length > 0) view.translatedRects = translated;
	return view;
}
