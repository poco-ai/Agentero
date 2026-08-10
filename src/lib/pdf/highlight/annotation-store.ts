import type {
	PdfAnnotationObject,
	PdfHighlightAnnoObject,
} from "@embedpdf/models";
import { PdfAnnotationSubtype } from "@embedpdf/models";
import type { AnnotationTransferItem } from "@embedpdf/plugin-annotation/react";
import { isTauri } from "@/lib/core/tauri";
import {
	type HighlightColor,
	highlightColorFromHex,
} from "@/lib/pdf/highlight/palette";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";
import {
	ANNOTATIONS_JSON,
	MARKS_FOLDER,
	markSelfWrite,
} from "@/lib/pdf/selection/marks-io";
import { joinVaultPath, readVaultFile, writeVaultFile } from "@/lib/vault";

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

function dedupeAnnotationItems(
	items: AnnotationTransferItem[],
): AnnotationTransferItem[] {
	const seen = new Set<string>();
	const out: AnnotationTransferItem[] = [];
	for (const item of items) {
		const id = item.annotation?.id;
		if (!id) {
			out.push(item);
			continue;
		}
		if (seen.has(id)) continue;
		seen.add(id);
		out.push(item);
	}
	return out;
}

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

export async function loadAnnotationItems(
	paperAbsPath: string,
): Promise<AnnotationTransferItem[]> {
	if (!paperAbsPath) return [];
	if (!isTauri()) {
		return dedupeAnnotationItems(memoryStore.get(paperAbsPath) ?? []);
	}

	// Prefer marks/; fall back to paper-root and migrate once.
	try {
		const raw = await readVaultFile(annotationsPath(paperAbsPath));
		const parsed = JSON.parse(raw) as unknown;
		return Array.isArray(parsed)
			? dedupeAnnotationItems(parsed as AnnotationTransferItem[])
			: [];
	} catch {
		// continue to legacy
	}

	try {
		const raw = await readVaultFile(legacyAnnotationsPath(paperAbsPath));
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		const items = dedupeAnnotationItems(parsed as AnnotationTransferItem[]);
		if (items.length) {
			await saveAnnotationItems(paperAbsPath, items);
		} else {
			// Empty file still belongs under marks/ once discovered.
			const path = annotationsPath(paperAbsPath);
			markSelfWrite(path);
			await writeVaultFile(path, `${JSON.stringify([], null, 2)}\n`);
		}
		await removeFileIfExists(legacyAnnotationsPath(paperAbsPath));
		return items;
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

export async function hasAnnotationsFile(
	paperAbsPath: string,
): Promise<boolean> {
	if (!paperAbsPath) return false;
	if (!isTauri()) return memoryStore.has(paperAbsPath);
	for (const path of [
		annotationsPath(paperAbsPath),
		legacyAnnotationsPath(paperAbsPath),
	]) {
		try {
			await readVaultFile(path);
			return true;
		} catch {
			// try next
		}
	}
	return false;
}

export function isHighlightObject(
	obj: PdfAnnotationObject,
): obj is PdfHighlightAnnoObject {
	return obj.type === PdfAnnotationSubtype.HIGHLIGHT;
}

/** App-specific metadata round-tripped through the annotation `custom` field. */
export type HighlightCustom = {
	app?: string;
	paletteKey?: HighlightColor;
	quote?: string;
};

export function highlightColorOf(obj: PdfHighlightAnnoObject): HighlightColor {
	const custom = (obj.custom ?? {}) as HighlightCustom;
	if (custom.paletteKey) return custom.paletteKey;
	return highlightColorFromHex(obj.strokeColor ?? obj.color);
}

export function highlightQuoteOf(obj: PdfHighlightAnnoObject): string {
	const custom = (obj.custom ?? {}) as HighlightCustom;
	return custom.quote?.trim() ?? "";
}

/** Build the PdfHighlight view model that the annotations panel + handle use. */
export function highlightViewFromObject(
	obj: PdfHighlightAnnoObject,
	paperPath: string,
): PdfHighlight {
	const iso = (d?: Date) =>
		d instanceof Date ? d.toISOString() : new Date().toISOString();
	const comment = obj.contents?.trim();
	const view: PdfHighlight = {
		version: 1,
		kind: "highlight",
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
	return view;
}
