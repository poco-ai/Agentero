import { createHash } from "node:crypto";
import { z } from "zod";
import { bboxIoU } from "../../src/lib/pdf/layout/dedupe";
import { unionBbox } from "../../src/lib/pdf/layout/merge-captions";
import type { PdfLayoutRegion } from "../../src/lib/pdf/layout/types";

const idSchema = z
	.union([z.number().int(), z.string().min(1)])
	.transform(String);
const blockSchema = z.object({
	anno_id: idSchema,
	category_type: z.string(),
	poly: z.array(z.number().finite()).length(8),
	ignore: z.boolean().optional(),
});
const pageSchema = z.object({
	page_info: z
		.object({
			image_path: z.string(),
			page_no: z.number().int().nonnegative(),
			width: z.number().positive(),
			height: z.number().positive(),
			page_attribute: z.object({ data_source: z.string() }).passthrough(),
		})
		.passthrough(),
	layout_dets: z.array(blockSchema),
	extra: z
		.object({
			relation: z
				.array(
					z.object({
						source_anno_id: idSchema,
						target_anno_id: idSchema,
						relation_type: z.string().optional(),
						relation: z.string().optional(),
					}),
				)
				.optional(),
		})
		.optional(),
});
export const datasetSchema = z.array(pageSchema);
export type SourcePage = z.input<typeof pageSchema>;
export type Box = PdfLayoutRegion["bbox"];
export type Target = {
	id: string;
	kind: "figure" | "table";
	bbox: Box;
	bodyBbox: Box;
	captionBbox: Box;
	memberIds: string[];
};
export type Case = {
	imagePath: string;
	documentId: string | null;
	split: "dev" | "test";
	width: number;
	height: number;
	sourcePage: number;
	targets: Target[];
	ignored: Box[];
	warnings: string[];
};
export type Manifest = {
	schemaVersion: 1;
	datasetSha256: string;
	source: string;
	seed: string;
	cases: Case[];
	exclusions: { imagePath: string; reason: string }[];
};
export const sha256 = (value: string | Uint8Array) =>
	createHash("sha256").update(value).digest("hex");
function box(
	block: z.output<typeof blockSchema>,
	page: z.output<typeof pageSchema>,
): Box {
	const xs = block.poly.filter((_, i) => i % 2 === 0),
		ys = block.poly.filter((_, i) => i % 2 === 1);
	const x = Math.min(...xs) / page.page_info.width,
		y = Math.min(...ys) / page.page_info.height;
	const w = Math.max(...xs) / page.page_info.width - x,
		h = Math.max(...ys) / page.page_info.height - y;
	if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.001 || y + h > 1.001)
		throw new Error(`Invalid geometry for annotation ${block.anno_id}`);
	return { x, y, w, h };
}
export function referenceCase(
	input: SourcePage,
): Omit<Case, "split" | "documentId"> {
	const page = pageSchema.parse(input);
	const {
		image_path: imagePath,
		width,
		height,
		page_no: sourcePage,
	} = page.page_info;
	const blocks = new Map(page.layout_dets.map((b) => [b.anno_id, b]));
	if (blocks.size !== page.layout_dets.length)
		throw new Error("Duplicate annotation ID");
	const valid = new Map(page.layout_dets.map((b) => [b.anno_id, box(b, page)]));
	const warnings: string[] = [],
		ignored: Box[] = [],
		targets: Target[] = [];
	for (const kind of ["figure", "table"] as const) {
		const hosts = page.layout_dets.filter(
			(b) => b.category_type === kind && !b.ignore,
		);
		const parent = new Map(hosts.map((h) => [h.anno_id, h.anno_id]));
		const root = (id: string): string => {
			let next = id;
			while (parent.get(next) !== next) next = parent.get(next) as string;
			return next;
		};
		const links = (page.extra?.relation ?? []).filter(
			(r) => (r.relation_type ?? r.relation) === "parent_son",
		);
		for (const r of links) {
			if (!blocks.has(r.source_anno_id) || !blocks.has(r.target_anno_id))
				throw new Error("Dangling relation");
			if (parent.has(r.source_anno_id) && parent.has(r.target_anno_id))
				parent.set(root(r.target_anno_id), root(r.source_anno_id));
		}
		const groups = new Map<string, typeof hosts>();
		for (const host of hosts) {
			const id = root(host.anno_id);
			groups.set(id, [...(groups.get(id) ?? []), host]);
		}
		const captionGroups = new Map<string, Set<string>>();
		for (const r of links) {
			const source = blocks.get(r.source_anno_id),
				target = blocks.get(r.target_anno_id);
			const hostId =
				source?.category_type === kind &&
				target?.category_type === `${kind}_caption`
					? r.source_anno_id
					: target?.category_type === kind &&
							source?.category_type === `${kind}_caption`
						? r.target_anno_id
						: undefined;
			if (hostId === undefined || !parent.has(hostId)) continue;
			const captionId =
				hostId === r.source_anno_id ? r.target_anno_id : r.source_anno_id;
			if (blocks.get(captionId)?.ignore) continue;
			const ids = captionGroups.get(captionId) ?? new Set<string>();
			ids.add(root(hostId));
			captionGroups.set(captionId, ids);
		}
		for (const [id, members] of groups) {
			const captions = [...captionGroups].filter(([, roots]) => roots.has(id));
			const bodyBbox = members
				.map((b) => valid.get(b.anno_id) as Box)
				.reduce(unionBbox);
			if (!captions.length || captions.some(([, roots]) => roots.size !== 1)) {
				ignored.push(bodyBbox);
				warnings.push(
					`${kind}:${id}: missing/ambiguous caption relation; excluded from crop scoring`,
				);
				continue;
			}
			const captionBbox = captions
				.map(([cid]) => valid.get(cid) as Box)
				.reduce(unionBbox);
			targets.push({
				id: `${kind}:${id}`,
				kind,
				bodyBbox,
				captionBbox,
				bbox: unionBbox(bodyBbox, captionBbox),
				memberIds: members.map((b) => b.anno_id),
			});
		}
	}
	ignored.push(
		...page.layout_dets
			.filter((b) => b.ignore && ["figure", "table"].includes(b.category_type))
			.map((b) => valid.get(b.anno_id) as Box),
	);
	return { imagePath, width, height, sourcePage, targets, ignored, warnings };
}
export function makeManifest(
	pages: SourcePage[],
	datasetSha256: string,
	source: string,
	seed: string,
	documentMap: Record<string, string>,
	limit: number,
): Manifest {
	const cases: Case[] = [],
		exclusions: Manifest["exclusions"] = [];
	for (const page of pages) {
		if (page.page_info.page_attribute.data_source !== "academic_literature")
			continue;
		try {
			const record = referenceCase(page);
			// UUID page filenames do not identify their source paper. Keep them dev-only
			// until an explicit paper map exists; do not pretend this is a document split.
			const documentId =
				documentMap[record.imagePath] ||
				record.imagePath.match(/^(.*\.pdf)_\d+\.[^.]+$/i)?.[1] ||
				null;
			const split =
				documentId &&
				parseInt(sha256(`${seed}:${documentId}`).slice(0, 8), 16) % 5 === 0
					? "test"
					: "dev";
			cases.push({ ...record, documentId, split });
		} catch (e) {
			exclusions.push({
				imagePath: page.page_info.image_path,
				reason: String(e),
			});
		}
	}
	// Stable selection independent of dataset order, with both positive and empty pages.
	cases.sort((a, b) =>
		sha256(`${seed}:${a.imagePath}`).localeCompare(
			sha256(`${seed}:${b.imagePath}`),
		),
	);
	const positive = cases.filter((p) => p.targets.length),
		negative = cases.filter((p) => !p.targets.length && !p.ignored.length);
	const selected = [
		...positive.slice(0, Math.ceil(limit * 0.8)),
		...negative.slice(0, Math.floor(limit * 0.2)),
	];
	const selectedNames = new Set(selected.map((p) => p.imagePath));
	selected.push(
		...cases
			.filter((p) => !selectedNames.has(p.imagePath))
			.slice(0, limit - selected.length),
	);
	return {
		schemaVersion: 1,
		datasetSha256,
		source,
		seed,
		cases: selected,
		exclusions,
	};
}
export function matchBoxes(
	predictions: { bbox: Box; kind: string }[],
	targets: { bbox: Box; kind: string }[],
	threshold: number,
) {
	const owner = new Map<number, number>();
	const edges = predictions.map((p) =>
		targets
			.map((t, index) => ({
				index,
				iou: p.kind === t.kind ? bboxIoU(p.bbox, t.bbox) : 0,
			}))
			.filter((e) => e.iou >= threshold)
			.sort((a, b) => b.iou - a.iou),
	);
	function assign(pred: number, seen: Set<number>): boolean {
		for (const { index } of edges[pred]) {
			if (seen.has(index)) continue;
			seen.add(index);
			const other = owner.get(index);
			if (other === undefined || assign(other, seen)) {
				owner.set(index, pred);
				return true;
			}
		}
		return false;
	}
	for (let i = 0; i < predictions.length; i++) assign(i, new Set());
	const matches = [...owner].map(([target, prediction]) => ({
		target,
		prediction,
		iou: bboxIoU(predictions[prediction].bbox, targets[target].bbox),
	}));
	return {
		tp: matches.length,
		fp: predictions.length - matches.length,
		fn: targets.length - matches.length,
		matches,
	};
}
export function scoreCase(
	predictions: PdfLayoutRegion[],
	record: Case,
	threshold: number,
) {
	const hosts = predictions
		.filter((r) => ["image", "chart", "table"].includes(r.kind))
		.map((r) => ({ ...r, kind: r.kind === "table" ? "table" : "figure" }));
	const scored = hosts.filter(
		(p) =>
			record.targets.some((t) => bboxIoU(p.bbox, t.bbox) >= 0.5) ||
			!record.ignored.some((b) => bboxIoU(p.bbox, b) >= 0.5),
	);
	return {
		...matchBoxes(scored, record.targets, threshold),
		predictions: scored,
		ignoredPredictions: hosts.length - scored.length,
	};
}
export function totals(scores: { tp: number; fp: number; fn: number }[]) {
	const tp = scores.reduce((n, s) => n + s.tp, 0),
		fp = scores.reduce((n, s) => n + s.fp, 0),
		fn = scores.reduce((n, s) => n + s.fn, 0);
	return {
		tp,
		fp,
		fn,
		precision: tp + fp ? tp / (tp + fp) : null,
		recall: tp + fn ? tp / (tp + fn) : null,
		f1: 2 * tp + fp + fn ? (2 * tp) / (2 * tp + fp + fn) : null,
	};
}
