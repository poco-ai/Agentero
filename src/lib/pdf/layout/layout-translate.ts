/**
 * Bulk page translation for layout body-text regions (text / abstract / header).
 * Progressive: callers apply each result as soon as it completes.
 */

import {
	listAgents,
	listenAgentCompleted,
	listenAgentFailed,
	runOnce,
} from "@/lib/agent";
import { LAYOUT_SIDEBAR_MIN_SCORE } from "@/lib/pdf/layout/constants";
import {
	isAlgorithmLayoutKind,
	isLayoutTranslatableKind,
} from "@/lib/pdf/layout/labels";
import { bboxCoveredBy } from "@/lib/pdf/layout/merge-captions";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";
import { loadSettings } from "@/lib/settings";
import { runTranslate } from "@/lib/translate";
import { resolveTranslateAgent } from "@/lib/translate/resolve-agent";
import type { TranslateRunOptions } from "@/lib/translate/types";

/** Soft cap per block to keep free-MT requests reasonable. */
export const LAYOUT_TRANSLATE_MAX_CHARS = 2500;

/** Parallel free/commercial MT workers (order of *start* follows reading order). */
export const LAYOUT_TRANSLATE_CONCURRENCY = 2;

export type LayoutTranslateRegion = {
	id: string;
	pageIndex: number;
	bbox: PdfLayoutRegion["bbox"];
	kind: PdfLayoutRegion["kind"];
	readingOrder: number;
	/** Source PDF text (trimmed, possibly truncated for the API). */
	source: string;
};

export type LayoutTranslateItemStatus =
	| "pending"
	| "running"
	| "done"
	| "error"
	| "skipped";

export type LayoutTranslateItem = LayoutTranslateRegion & {
	status: LayoutTranslateItemStatus;
	/** Translated text when status is done (or partial). */
	translated?: string;
	error?: string;
};

export type LayoutTranslateJobStatus =
	| "idle"
	| "running"
	| "done"
	| "cancelled";

/** Prefer body extract; fall back to caption title for headers. */
export function layoutRegionSourceText(region: PdfLayoutRegion): string {
	return (region.text ?? region.title ?? "").replace(/\s+/g, " ").trim();
}

/** True when most of `region` sits inside an algorithm detection box. */
export function isInsideAlgorithmRegion(
	region: PdfLayoutRegion,
	algorithms: readonly PdfLayoutRegion[],
	coverage = 0.45,
): boolean {
	for (const alg of algorithms) {
		if (alg.pageIndex !== region.pageIndex) continue;
		if (bboxCoveredBy(region.bbox, alg.bbox) >= coverage) return true;
	}
	return false;
}

/** "Algorithm 1" / "Alg. 2" style titles — keep original, do not translate. */
export function isAlgorithmTitleText(text: string): boolean {
	const t = text.trim();
	if (!t) return false;
	return /^(algorithm|alg\.?)\s*\d/i.test(t);
}

/**
 * PP-DocLayoutV3 reference labels (mapped to kind `text` in LABEL_TO_KIND).
 * Raw `label` is still preserved on the region.
 */
export function isReferenceLayoutLabel(label: string): boolean {
	const k = label.trim().toLowerCase();
	return k === "reference" || k === "reference_content";
}

/** PP-DocLayoutV3 side-margin text (`aside_text` → kind text; keep raw label). */
export function isAsideTextLayoutLabel(label: string): boolean {
	return label.trim().toLowerCase() === "aside_text";
}

/** Section headings like "References" / "Bibliography" / "参考文献". */
export function isReferenceSectionTitle(text: string): boolean {
	const t = text.trim();
	if (!t || t.length > 64) return false;
	return /^(references?|bibliography|works\s+cited|参考文[献獻])\b/i.test(t);
}

/**
 * Reading-order list of regions with extractable source text
 * (body, abstract, headers, figure/table captions).
 * Skips algorithm / reference / aside_text regions (and text inside them).
 */
export function listTranslatableLayoutRegions(
	regions: readonly PdfLayoutRegion[],
	minScore: number = LAYOUT_SIDEBAR_MIN_SCORE,
): LayoutTranslateRegion[] {
	const algorithms = regions.filter(
		(r) => isAlgorithmLayoutKind(r.kind) && r.score >= minScore,
	);
	// reference / reference_content are stored as kind=text; use raw label.
	const referenceBlocks = regions.filter(
		(r) => isReferenceLayoutLabel(r.label) && r.score >= minScore,
	);
	const out: LayoutTranslateRegion[] = [];
	for (const r of regions) {
		// Never translate algorithm detections themselves.
		if (isAlgorithmLayoutKind(r.kind)) continue;
		// Bibliography entries from the layout model.
		if (isReferenceLayoutLabel(r.label)) continue;
		// Side-margin / running column text (e.g. arXiv strip when labeled aside_text).
		if (isAsideTextLayoutLabel(r.label)) continue;
		if (!isLayoutTranslatableKind(r.kind)) continue;
		if (!(r.score >= minScore)) continue;
		if (!(r.bbox.w > 0 && r.bbox.h > 0)) continue;
		// Pseudocode / lines inside an algorithm bbox stay in the original language.
		if (isInsideAlgorithmRegion(r, algorithms)) continue;
		// Text/headers nested inside a reference block (e.g. multi-line cites).
		if (isInsideAlgorithmRegion(r, referenceBlocks)) continue;
		const full = layoutRegionSourceText(r);
		if (!full) continue;
		if (isAlgorithmTitleText(full)) continue;
		if (isReferenceSectionTitle(full)) continue;
		const source =
			full.length > LAYOUT_TRANSLATE_MAX_CHARS
				? `${full.slice(0, LAYOUT_TRANSLATE_MAX_CHARS)}…`
				: full;
		out.push({
			id: r.id,
			pageIndex: r.pageIndex,
			bbox: r.bbox,
			kind: r.kind,
			readingOrder: r.readingOrder,
			source,
		});
	}
	out.sort(
		(a, b) =>
			a.pageIndex - b.pageIndex ||
			a.readingOrder - b.readingOrder ||
			a.bbox.y - b.bbox.y ||
			a.bbox.x - b.bbox.x,
	);
	return out;
}

export function toLayoutTranslateItems(
	regions: readonly LayoutTranslateRegion[],
): LayoutTranslateItem[] {
	return regions.map((r) => ({ ...r, status: "pending" as const }));
}

/** Paint-relevant identity of one bucket slot (id, progress, partial text). */
function sameLayoutTranslateBucketSlot(
	before: LayoutTranslateItem | undefined,
	after: LayoutTranslateItem,
): boolean {
	return (
		before !== undefined &&
		before.id === after.id &&
		before.status === after.status &&
		before.translated === after.translated
	);
}

/**
 * Bucket job items by page so each page overlay reads its own list instead of
 * filtering the whole job. When `previous` is given, a bucket whose
 * paint-relevant contents are unchanged reuses the previous array identity, so
 * memoized page overlays bail out while the streaming job only touches the
 * page currently translating.
 */
export function groupLayoutTranslateItemsByPage(
	items: readonly LayoutTranslateItem[],
	previous?: ReadonlyMap<number, readonly LayoutTranslateItem[]>,
): ReadonlyMap<number, readonly LayoutTranslateItem[]> {
	const grouped = new Map<number, LayoutTranslateItem[]>();
	for (const item of items) {
		const bucket = grouped.get(item.pageIndex);
		if (bucket) bucket.push(item);
		else grouped.set(item.pageIndex, [item]);
	}
	if (!previous) return grouped;
	const next: Map<number, readonly LayoutTranslateItem[]> = new Map(grouped);
	for (const [pageIndex, bucket] of grouped) {
		const prev = previous.get(pageIndex);
		if (
			prev &&
			prev.length === bucket.length &&
			bucket.every((item, i) => sameLayoutTranslateBucketSlot(prev[i], item))
		) {
			next.set(pageIndex, prev);
		}
	}
	return next;
}

/** Non-streaming Agent runner for bulk layout translate (settings provider=agent). */
async function resolveLayoutTranslateAgentOpts(): Promise<
	TranslateRunOptions | undefined
> {
	const settings = loadSettings();
	if (settings.translate.provider !== "agent") return undefined;
	const registry = await listAgents().catch(() => null);
	const resolved = resolveTranslateAgent(settings.translate, registry);
	if (!resolved.agentId) {
		throw new Error("No Agent configured for translation");
	}
	const agentId = resolved.agentId;
	const modelId = resolved.modelId;
	return {
		agent: {
			runOnce: async (prompt: string) => {
				const accepted = await runOnce({
					prompt,
					agentId,
					modelId,
					workflow: "free",
					autoApprove: true,
					hideFromChatHistory: true,
				});
				const sessionId = accepted.sessionId;
				return await new Promise<string>((resolve, reject) => {
					const unsubs: Array<() => void> = [];
					const cleanup = () => {
						for (const u of unsubs) u();
					};
					void listenAgentCompleted((ev) => {
						if (ev.sessionId !== sessionId) return;
						cleanup();
						resolve((ev.content ?? "").trim());
					}).then((u) => unsubs.push(u));
					void listenAgentFailed((ev) => {
						if (ev.sessionId !== sessionId) return;
						cleanup();
						reject(new Error(ev.error || "Agent translation failed"));
					}).then((u) => unsubs.push(u));
				});
			},
		},
	};
}

/**
 * Translate regions with bounded concurrency. Invokes `onUpdate` after each
 * item settles so the UI can paint overlays progressively.
 */
export async function runLayoutRegionTranslate(options: {
	items: LayoutTranslateItem[];
	signal?: AbortSignal;
	concurrency?: number;
	onUpdate: (items: LayoutTranslateItem[]) => void;
}): Promise<LayoutTranslateItem[]> {
	const agentOpts = await resolveLayoutTranslateAgentOpts();
	// Agent is heavy — serialize; free/commercial MT keeps a small pool.
	const concurrency = Math.max(
		1,
		agentOpts ? 1 : (options.concurrency ?? LAYOUT_TRANSLATE_CONCURRENCY),
	);
	const items = options.items.map((it) => ({ ...it }));
	const signal = options.signal;
	let nextIndex = 0;

	const publish = () => options.onUpdate(items.map((it) => ({ ...it })));

	const worker = async () => {
		while (true) {
			if (signal?.aborted) return;
			const i = nextIndex;
			nextIndex += 1;
			if (i >= items.length) return;
			const item = items[i];
			if (!item) return;
			item.status = "running";
			publish();
			try {
				if (signal?.aborted) {
					item.status = "skipped";
					publish();
					return;
				}
				const translated = await runTranslate(
					{
						text: item.source,
						context: {
							page: item.pageIndex + 1,
							surface: "pdf-layout-bulk",
						},
					},
					agentOpts,
				);
				if (signal?.aborted) {
					item.status = "skipped";
					publish();
					return;
				}
				item.translated = translated.trim();
				item.status = item.translated ? "done" : "error";
				if (!item.translated) item.error = "Empty translation result";
			} catch (e) {
				if (signal?.aborted) {
					item.status = "skipped";
				} else {
					item.status = "error";
					item.error = e instanceof Error ? e.message : String(e);
				}
			}
			publish();
		}
	};

	const pool = Array.from(
		{ length: Math.min(concurrency, Math.max(1, items.length)) },
		() => worker(),
	);
	await Promise.all(pool);

	if (signal?.aborted) {
		for (const it of items) {
			if (it.status === "pending" || it.status === "running") {
				it.status = "skipped";
			}
		}
		publish();
	}

	return items;
}
