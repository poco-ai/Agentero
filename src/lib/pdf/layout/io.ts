import {
	assessLayoutReadiness,
	type LayoutCompleteness,
	parseLayoutCompleteness,
} from "@/lib/pdf/layout/completeness";
import {
	buildLayoutIndexSidecar,
	LAYOUT_INDEX_FILE,
	type LayoutIndexItem,
	type LayoutIndexSidecar,
	parseBbox,
	parseLayoutIndexSidecar,
} from "@/lib/pdf/layout/layout-index";
import { mergeCaptionsIntoHosts } from "@/lib/pdf/layout/merge-captions";
import { parseLayoutSourceStyle } from "@/lib/pdf/layout/source-style";
import type { PdfLayoutKind, PdfLayoutRegion } from "@/lib/pdf/layout/types";
import { joinVaultPath, readVaultFile, writeVaultFile } from "@/lib/vault";

/** Bump when label mapping / stored region semantics change (invalidates cache). */
export const LAYOUT_SIDECAR_SCHEMA_VERSION = 3;
export const LAYOUT_SIDECAR_FILE = "layout.json";
const TEXT_GEOMETRY_VERSION = 4;

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
		/** Rich PDF run styles sampled; old caches need only a text walk. */
		sourceStylesExtracted?: boolean;
		/** Text geometry revision; a new revision walks text without rerunning the model. */
		textGeometryVersion?: number;
		/** Verifiable page coverage and content-readiness metadata. */
		completeness?: LayoutCompleteness;
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
	const parsedRect = parseBbox(rect);
	const parsedBbox = parseBbox(bbox);
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
	const sourceStyle = parseLayoutSourceStyle(value.sourceStyle);
	if (sourceStyle) out.sourceStyle = sourceStyle;
	const titleBbox = parseBbox(value.titleBbox);
	if (titleBbox) out.titleBbox = titleBbox;
	if (
		Number.isInteger(value.captionPageIndex) &&
		(value.captionPageIndex as number) >= 0
	) {
		out.captionPageIndex = value.captionPageIndex as number;
		const captionBbox = parseBbox(value.captionBbox);
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
	if (raw.source.sourceStylesExtracted === true)
		source.sourceStylesExtracted = true;
	if (raw.source.figureCaptionsExtracted === true)
		source.figureCaptionsExtracted = true;
	if (typeof raw.source.textGeometryVersion === "number")
		source.textGeometryVersion = raw.source.textGeometryVersion;
	const completeness = parseLayoutCompleteness(raw.source.completeness);
	if (completeness) source.completeness = completeness;
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
 * A sidecar is reusable only when its page walk proves it complete. `force`
 * always reparses; legacy / partial caches are audited by headless analysis.
 */
export function layoutSidecarBlocksAnalysis(
	force: boolean | undefined,
	sidecar: PdfLayoutSidecar,
): boolean {
	if (force === true) return false;
	const readiness = assessLayoutReadiness(sidecar.source.completeness);
	if (readiness.status === "ready") return true;
	return readiness.status === "warning" && !readiness.needsContentRepair;
}

/** Old sidecars, and reads that did not finish, still need the text layer. */
export function layoutSidecarNeedsTextLayer(
	sidecar: PdfLayoutSidecar,
): boolean {
	return (
		sidecar.source.textGeometryVersion !== TEXT_GEOMETRY_VERSION ||
		sidecar.source.sourceStylesExtracted !== true ||
		sidecar.source.textLayerExtracted !== true ||
		(sidecar.source.mode === "mineru-layout" &&
			sidecar.source.figureCaptionsExtracted !== true)
	);
}

type LayoutWriteListener = (paperAbsPath: string) => void;

const layoutWriteListeners = new Set<LayoutWriteListener>();

/** Completion caches parsed anchors; layout writes drop that cache. */
export function subscribeLayoutSidecarWrite(
	listener: LayoutWriteListener,
): () => void {
	layoutWriteListeners.add(listener);
	return () => {
		layoutWriteListeners.delete(listener);
	};
}

function notifyLayoutSidecarWrite(paperAbsPath: string): void {
	for (const listener of layoutWriteListeners) listener(paperAbsPath);
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
	options: {
		textLayerExtracted?: boolean;
		completeness?: LayoutCompleteness;
	} = {},
): Promise<void> {
	if (!paperAbsPath) return;
	if (
		options.completeness &&
		assessLayoutReadiness(options.completeness).status === "incomplete"
	) {
		const current = await readLayoutSidecar(paperAbsPath);
		const currentStatus = assessLayoutReadiness(
			current?.source.completeness,
		).status;
		if (
			current &&
			current.regions.length > 0 &&
			(currentStatus === "ready" || currentStatus === "warning")
		) {
			// A failed text-layer walk must not replace a trusted parse.
			return;
		}
	}
	const source: PdfLayoutSidecar["source"] = {
		mode,
		generatedAt: new Date().toISOString(),
	};
	if (options.completeness) source.completeness = options.completeness;
	if (
		options.completeness?.textLayerComplete === true ||
		options.textLayerExtracted === true
	) {
		source.textLayerExtracted = true;
		source.figureCaptionsExtracted = true;
		source.sourceStylesExtracted = true;
		source.textGeometryVersion = TEXT_GEOMETRY_VERSION;
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
	notifyLayoutSidecarWrite(paperAbsPath);
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
	completeness?: LayoutCompleteness,
): PdfLayoutSidecar {
	const sidecar: PdfLayoutSidecar = {
		schemaVersion: LAYOUT_SIDECAR_SCHEMA_VERSION,
		source: {
			mode: expected.source.mode,
			generatedAt: expected.source.generatedAt,
			textLayerExtracted: true,
			figureCaptionsExtracted: true,
			sourceStylesExtracted: true,
			textGeometryVersion: TEXT_GEOMETRY_VERSION,
		},
		regions,
	};
	if (completeness) sidecar.source.completeness = completeness;
	return sidecar;
}

/**
 * Write extracted text only when `layout.json` is still the parse we read.
 * A newer headless analysis wins; a partial walk must not call this.
 */
export async function writeLayoutTextBackfill(
	paperAbsPath: string | null | undefined,
	expected: PdfLayoutSidecar,
	regions: PdfLayoutRegion[],
	completeness?: LayoutCompleteness,
): Promise<boolean> {
	if (!paperAbsPath) return false;
	const current = await readLayoutSidecar(paperAbsPath);
	if (!current || !sameLayoutParse(current, expected)) return false;
	const sidecar = layoutTextBackfillSidecar(expected, regions, completeness);
	await writeVaultFile(
		layoutSidecarPath(paperAbsPath),
		`${JSON.stringify(sidecar, null, 2)}\n`,
	);
	notifyLayoutSidecarWrite(paperAbsPath);
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
