import {
	buildLayoutIndexSidecar,
	LAYOUT_INDEX_FILE,
	type LayoutIndexItem,
	type LayoutIndexSidecar,
	parseLayoutIndexSidecar,
} from "@/lib/pdf/layout/layout-index";
import { mergeCaptionsIntoHosts } from "@/lib/pdf/layout/merge-captions";
import type { PdfLayoutKind, PdfLayoutRegion } from "@/lib/pdf/layout/types";
import { joinVaultPath, readVaultFile, writeVaultFile } from "@/lib/vault";

/** Bump when label mapping / stored region semantics change (invalidates cache). */
export const LAYOUT_SIDECAR_SCHEMA_VERSION = 3;
export const LAYOUT_SIDECAR_FILE = "layout.json";
/** Re-export for consumers that only import from `io`. */
export { LAYOUT_INDEX_FILE } from "@/lib/pdf/layout/layout-index";

/** Producer recorded in `source.mode` — which backend generated the regions. */
export type LayoutSidecarMode =
	| "embedpdf-layout"
	| "paddle-layout"
	| "mineru-layout";

const LAYOUT_SIDECAR_MODES: readonly LayoutSidecarMode[] = [
	"embedpdf-layout",
	"paddle-layout",
	"mineru-layout",
];

export type PdfLayoutSidecar = {
	schemaVersion: number;
	source: {
		mode: LayoutSidecarMode;
		generatedAt: string;
		/**
		 * The PDF text layer was walked for this parse. Boxes that stayed
		 * empty still count. Absent on sidecars written before that walk
		 * was recorded, including ones that already stored text.
		 */
		textLayerExtracted?: boolean;
		/** Numbered captions have been recovered directly from PDF text runs. */
		figureCaptionsExtracted?: boolean;
	};
	/** Raw text-enriched model regions, before caption/formula merge. */
	regions: PdfLayoutRegion[];
};

const LAYOUT_KINDS = new Set<PdfLayoutKind>([
	"image",
	"table",
	"algorithm",
	"formula",
	"formula_number",
	"chart",
	"figure_title",
	"header",
	"abstract",
	"text",
]);

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

function parseRect(value: unknown): PdfLayoutRegion["rect"] | null {
	if (!isObject(value)) return null;
	const { x, y, w, h } = value;
	if (
		!isFiniteNumber(x) ||
		!isFiniteNumber(y) ||
		!isFiniteNumber(w) ||
		!isFiniteNumber(h)
	) {
		return null;
	}
	return { x, y, w, h };
}

function parseRegion(value: unknown): PdfLayoutRegion | null {
	if (!isObject(value)) return null;
	const { id, pageIndex, kind, label, score, readingOrder, rect, bbox } = value;
	if (
		typeof id !== "string" ||
		!isFiniteNumber(pageIndex) ||
		typeof kind !== "string" ||
		!LAYOUT_KINDS.has(kind as PdfLayoutKind) ||
		typeof label !== "string" ||
		!isFiniteNumber(score) ||
		!isFiniteNumber(readingOrder)
	) {
		return null;
	}
	const parsedRect = parseRect(rect);
	const parsedBbox = parseRect(bbox);
	if (!parsedRect || !parsedBbox) return null;
	const out: PdfLayoutRegion = {
		id,
		pageIndex,
		kind: kind as PdfLayoutKind,
		label,
		score,
		readingOrder,
		rect: parsedRect,
		bbox: parsedBbox,
	};
	if (typeof value.title === "string") out.title = value.title;
	if (typeof value.text === "string") out.text = value.text;
	const titleBbox = parseRect(value.titleBbox);
	if (titleBbox) out.titleBbox = titleBbox;
	if (
		Number.isInteger(value.captionPageIndex) &&
		(value.captionPageIndex as number) >= 0
	) {
		out.captionPageIndex = value.captionPageIndex as number;
		const captionBbox = parseRect(value.captionBbox);
		if (captionBbox) out.captionBbox = captionBbox;
	}
	if (
		value.captionRole === "figure_main" ||
		value.captionRole === "table_main" ||
		value.captionRole === "algorithm_main" ||
		value.captionRole === "subpanel" ||
		value.captionRole === "other"
	) {
		out.captionRole = value.captionRole;
	}
	return out;
}

export function layoutSidecarPath(paperAbsPath: string): string {
	return joinVaultPath(
		joinVaultPath(paperAbsPath, "source"),
		LAYOUT_SIDECAR_FILE,
	);
}

export function layoutIndexPath(paperAbsPath: string): string {
	return joinVaultPath(
		joinVaultPath(paperAbsPath, "source"),
		LAYOUT_INDEX_FILE,
	);
}

export function parseLayoutSidecar(raw: unknown): PdfLayoutSidecar | null {
	if (!isObject(raw)) return null;
	if (raw.schemaVersion !== LAYOUT_SIDECAR_SCHEMA_VERSION) return null;
	if (
		!isObject(raw.source) ||
		!LAYOUT_SIDECAR_MODES.includes(raw.source.mode as LayoutSidecarMode)
	) {
		return null;
	}
	if (typeof raw.source.generatedAt !== "string") return null;
	if (!Array.isArray(raw.regions)) return null;
	const regions = raw.regions.map(parseRegion);
	if (regions.some((r) => !r)) return null;
	const source: PdfLayoutSidecar["source"] = {
		mode: raw.source.mode as LayoutSidecarMode,
		generatedAt: raw.source.generatedAt,
	};
	if (raw.source.textLayerExtracted === true) source.textLayerExtracted = true;
	if (raw.source.figureCaptionsExtracted === true)
		source.figureCaptionsExtracted = true;
	return {
		schemaVersion: LAYOUT_SIDECAR_SCHEMA_VERSION,
		source,
		regions: regions as PdfLayoutRegion[],
	};
}

/**
 * The open viewer should merge this sidecar into its tab store.
 * Empty and unchanged parses are ignored so a text-layer write-back of the
 * same `generatedAt` does not reload forever.
 */
export function layoutSidecarNeedsViewerReload(
	appliedGeneratedAt: string | null | undefined,
	sidecar: { generatedAt: string; regionCount: number } | null,
): boolean {
	if (!sidecar || sidecar.regionCount <= 0 || !sidecar.generatedAt)
		return false;
	return appliedGeneratedAt !== sidecar.generatedAt;
}

/**
 * A cache merge started on `startedAt` must not publish if a newer parse
 * landed while it was reading. Otherwise a force re-run's result is
 * overwritten by the one-page sidecar the viewer already had in memory.
 */
export function layoutSidecarWasReplaced(
	startedAt: string,
	latestGeneratedAt: string | null | undefined,
): boolean {
	return latestGeneratedAt != null && latestGeneratedAt !== startedAt;
}

/**
 * A non-empty sidecar is a finished parse. `force` is the only way through
 * it: headless analysis used to return here even when the job was enqueued
 * with `force: true`.
 */
export function layoutSidecarBlocksAnalysis(
	force: boolean | undefined,
	regionCount: number,
): boolean {
	return force !== true && regionCount > 0;
}

/** Old sidecars, and reads that did not finish, still need the text layer. */
export function layoutSidecarNeedsTextLayer(
	sidecar: PdfLayoutSidecar,
): boolean {
	return (
		sidecar.source.textLayerExtracted !== true ||
		(sidecar.source.mode === "mineru-layout" &&
			sidecar.source.figureCaptionsExtracted !== true)
	);
}

export async function readLayoutSidecar(
	paperAbsPath: string | null | undefined,
): Promise<PdfLayoutSidecar | null> {
	if (!paperAbsPath) return null;
	try {
		const text = await readVaultFile(layoutSidecarPath(paperAbsPath));
		return parseLayoutSidecar(JSON.parse(text));
	} catch {
		return null;
	}
}

export async function writeLayoutSidecar(
	paperAbsPath: string | null | undefined,
	regions: PdfLayoutRegion[],
	mode: LayoutSidecarMode = "embedpdf-layout",
	options: { textLayerExtracted?: boolean } = {},
): Promise<void> {
	if (!paperAbsPath) return;
	const source: PdfLayoutSidecar["source"] = {
		mode,
		generatedAt: new Date().toISOString(),
	};
	if (options.textLayerExtracted === true) {
		source.textLayerExtracted = true;
		source.figureCaptionsExtracted = true;
	}
	const sidecar: PdfLayoutSidecar = {
		schemaVersion: LAYOUT_SIDECAR_SCHEMA_VERSION,
		source,
		regions,
	};
	await writeVaultFile(
		layoutSidecarPath(paperAbsPath),
		`${JSON.stringify(sidecar, null, 2)}\n`,
	);
}

function layoutRectEqual(
	a: PdfLayoutRegion["rect"],
	b: PdfLayoutRegion["rect"],
): boolean {
	return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

function layoutRegionGeometryEqual(
	a: PdfLayoutRegion,
	b: PdfLayoutRegion,
): boolean {
	return (
		a.id === b.id &&
		a.pageIndex === b.pageIndex &&
		a.kind === b.kind &&
		a.label === b.label &&
		a.score === b.score &&
		a.readingOrder === b.readingOrder &&
		layoutRectEqual(a.rect, b.rect) &&
		layoutRectEqual(a.bbox, b.bbox)
	);
}

/** Same model parse: mode, timestamp, and box geometry. Text may differ. */
export function sameLayoutParse(
	a: PdfLayoutSidecar,
	b: PdfLayoutSidecar,
): boolean {
	if (a.source.mode !== b.source.mode) return false;
	if (a.source.generatedAt !== b.source.generatedAt) return false;
	if (a.regions.length !== b.regions.length) return false;
	return a.regions.every((region, index) => {
		const other = b.regions[index];
		return other ? layoutRegionGeometryEqual(region, other) : false;
	});
}

/** Text-layer backfill keeps the parse timestamp and records the walk. */
export function layoutTextBackfillSidecar(
	expected: PdfLayoutSidecar,
	regions: PdfLayoutRegion[],
): PdfLayoutSidecar {
	return {
		schemaVersion: LAYOUT_SIDECAR_SCHEMA_VERSION,
		source: {
			mode: expected.source.mode,
			generatedAt: expected.source.generatedAt,
			textLayerExtracted: true,
			figureCaptionsExtracted: true,
		},
		regions,
	};
}

/**
 * Write extracted text only when `layout.json` is still the parse we read.
 * A newer headless analysis wins; a partial walk must not call this.
 */
export async function writeLayoutTextBackfill(
	paperAbsPath: string | null | undefined,
	expected: PdfLayoutSidecar,
	regions: PdfLayoutRegion[],
): Promise<boolean> {
	if (!paperAbsPath) return false;
	const current = await readLayoutSidecar(paperAbsPath);
	if (!current || !sameLayoutParse(current, expected)) return false;
	const sidecar = layoutTextBackfillSidecar(expected, regions);
	await writeVaultFile(
		layoutSidecarPath(paperAbsPath),
		`${JSON.stringify(sidecar, null, 2)}\n`,
	);
	return true;
}

export async function readLayoutIndex(
	paperAbsPath: string | null | undefined,
): Promise<LayoutIndexSidecar | null> {
	if (!paperAbsPath) return null;
	try {
		const text = await readVaultFile(layoutIndexPath(paperAbsPath));
		return parseLayoutIndexSidecar(JSON.parse(text));
	} catch {
		return null;
	}
}

function layoutIndexItemEqual(a: LayoutIndexItem, b: LayoutIndexItem): boolean {
	return (
		a.id === b.id &&
		a.stableKey === b.stableKey &&
		a.kind === b.kind &&
		a.section === b.section &&
		a.page === b.page &&
		a.pageIndex === b.pageIndex &&
		a.score === b.score &&
		a.layoutRegionId === b.layoutRegionId &&
		(a.title ?? "") === (b.title ?? "") &&
		a.bbox.x === b.bbox.x &&
		a.bbox.y === b.bbox.y &&
		a.bbox.w === b.bbox.w &&
		a.bbox.h === b.bbox.h
	);
}

/** Content comparison that ignores the volatile `generatedAt` timestamp. */
function layoutIndexContentEqual(
	a: LayoutIndexSidecar,
	b: LayoutIndexSidecar,
): boolean {
	if (a.schemaVersion !== b.schemaVersion) return false;
	if (a.source.minScore !== b.source.minScore) return false;
	if (a.items.length !== b.items.length) return false;
	return a.items.every((item, i) => layoutIndexItemEqual(item, b.items[i]));
}

/**
 * Write sidebar-aligned index from **post-merge** regions.
 * Skips the disk write when the existing sidecar already matches, so a cache
 * hit produces zero writes (and no watcher echo).
 */
export async function writeLayoutIndex(
	paperAbsPath: string | null | undefined,
	mergedRegions: readonly PdfLayoutRegion[],
): Promise<LayoutIndexSidecar | null> {
	if (!paperAbsPath) return null;
	const index = buildLayoutIndexSidecar(mergedRegions);
	const existing = await readLayoutIndex(paperAbsPath);
	if (existing && layoutIndexContentEqual(existing, index)) {
		return existing;
	}
	await writeVaultFile(
		layoutIndexPath(paperAbsPath),
		`${JSON.stringify(index, null, 2)}\n`,
	);
	return index;
}

/**
 * Rebuild `layout-index.json` from raw `layout.json` regions
 * (merge + sidebar filter). Safe to call whenever raw sidecar is present.
 */
export async function writeLayoutIndexFromRaw(
	paperAbsPath: string | null | undefined,
	rawRegions: readonly PdfLayoutRegion[],
): Promise<LayoutIndexSidecar | null> {
	if (!paperAbsPath) return null;
	const merged = mergeCaptionsIntoHosts([...rawRegions]);
	return writeLayoutIndex(paperAbsPath, merged);
}
