import { z } from "zod";
import { bboxIoU, dedupeLayoutRegions } from "../../src/lib/pdf/layout/dedupe";
import {
	bboxCoveredBy,
	mergeCaptionsIntoHosts,
} from "../../src/lib/pdf/layout/merge-captions";
import { resolveCaptionRole } from "../../src/lib/pdf/layout/title-text";
import type {
	PdfLayoutKind,
	PdfLayoutRegion,
} from "../../src/lib/pdf/layout/types";

// Follows MinerU-Popo's NormalizedBlock field names; this adapter explicitly
// uses relative xyxy and zero-based pages, not the model prompt's yxyx/1000.
const kindSchema = z.enum([
	"image",
	"chart",
	"table",
	"algorithm",
	"formula",
	"formula_number",
	"figure_title",
	"header",
	"abstract",
	"text",
]);
export const normalizedBlockSchema = z.object({
	block_id: z.string().min(1),
	page: z.number().int().nonnegative(),
	bbox: z
		.tuple([
			z.number().min(0).max(1),
			z.number().min(0).max(1),
			z.number().min(0).max(2),
			z.number().min(0).max(2),
		])
		.refine(
			([x1, y1, x2, y2]) =>
				x2 > x1 && y2 > y1 && x2 - x1 <= 1.000001 && y2 - y1 <= 1.000001,
		),
	type: z.enum(["title", "text", "image", "table", "caption"]),
	content: z.string(),
	order: z.number().int(),
	popo_type: z.string(),
	source_label: z.string(),
	meta: z.object({
		score: z.number().finite().min(0).max(1),
		kind: kindSchema,
		captionRole: z
			.enum([
				"figure_main",
				"table_main",
				"algorithm_main",
				"subpanel",
				"other",
			])
			.optional(),
	}),
});
export type NormalizedBlock = z.infer<typeof normalizedBlockSchema>;
export function normalizeLayoutRegions(
	regions: PdfLayoutRegion[],
): NormalizedBlock[] {
	return regions.map<NormalizedBlock>((r) => {
		const caption = r.kind === "figure_title",
			role = caption ? resolveCaptionRole(r) : undefined;
		const type =
			r.kind === "table"
				? "table"
				: r.kind === "image" || r.kind === "chart"
					? "image"
					: caption
						? "caption"
						: r.kind === "header"
							? "title"
							: "text";
		return {
			block_id: r.id,
			page: r.pageIndex,
			bbox: [r.bbox.x, r.bbox.y, r.bbox.x + r.bbox.w, r.bbox.y + r.bbox.h],
			type,
			content: r.title ?? r.text ?? "",
			order: r.readingOrder,
			popo_type: caption
				? role === "table_main"
					? "table_caption"
					: "image_caption"
				: type,
			source_label: r.label,
			meta: { kind: r.kind, score: r.score, captionRole: role },
		};
	});
}
function toRegion(b: NormalizedBlock): PdfLayoutRegion {
	const [x, y, x2, y2] = b.bbox,
		bbox = { x, y, w: x2 - x, h: y2 - y };
	const kind: PdfLayoutKind = b.meta.kind;
	return {
		id: b.block_id,
		pageIndex: b.page,
		bbox,
		rect: { ...bbox },
		kind,
		label: b.source_label,
		readingOrder: b.order,
		score: b.meta.score,
		text: b.content || undefined,
		title: ["figure_title", "header"].includes(kind)
			? b.content || undefined
			: undefined,
		captionRole: b.meta.captionRole,
	};
}
export function inferHeuristicAssociations(input: unknown) {
	const blocks = z.array(normalizedBlockSchema).parse(input);
	if (new Set(blocks.map((b) => b.block_id)).size !== blocks.length)
		throw new Error("Duplicate normalized block ID");
	const regions = blocks.map(toRegion);
	// Popo removes ordinary text from its model prompt. Our existing geometric
	// heuristics need it as a barrier, so retain it for merge but filter link outputs.
	const merged = dedupeLayoutRegions(mergeCaptionsIntoHosts(regions));
	const objects = merged
		.filter((r) => ["image", "chart", "table"].includes(r.kind))
		.map((r) => ({
			id: `merged:${r.pageIndex}:${r.id}`,
			regionId: r.id,
			page: r.pageIndex,
			kind: r.kind,
			bbox: r.bbox,
			memberIds: regions
				.filter(
					(source) =>
						source.pageIndex === r.pageIndex &&
						(r.kind === "table"
							? source.kind === "table"
							: ["image", "chart"].includes(source.kind)) &&
						bboxCoveredBy(source.bbox, r.bbox) >= 0.9,
				)
				.map((source) => source.id),
			membershipBasis: "contained-by-result",
		}));
	const links: { src: string; tgt: string; reason: string }[] = [];
	for (const host of merged.filter((r) =>
		["image", "chart", "table"].includes(r.kind),
	)) {
		const captionBbox = host.titleBbox ?? host.captionBbox;
		if (!captionBbox) continue;
		const captionPage = host.titleBbox ? host.pageIndex : host.captionPageIndex;
		const candidates = regions.filter(
			(r) =>
				r.pageIndex === captionPage &&
				["figure_title", "header", "text"].includes(r.kind) &&
				bboxIoU(r.bbox, captionBbox) >= 0.99,
		);
		// Do not invent source identities for synthesized/recovered captions.
		const object = objects.find(
			(o) => o.regionId === host.id && o.page === host.pageIndex,
		);
		const representative = object?.memberIds.includes(host.id)
			? host.id
			: object?.memberIds[0];
		if (candidates.length === 1 && representative)
			links.push({
				src: candidates[0].id,
				tgt: representative,
				reason:
					"caption geometry retained by merge; target is a contained source host representative",
			});
	}
	return {
		regions,
		merged,
		objects,
		links,
		backend: "agentero-heuristic" as const,
		capabilities: ["figure-grouping", "caption-association", "crop-union"],
	};
}
