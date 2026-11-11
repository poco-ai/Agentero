import { dedupeLayoutRegions } from "@/lib/pdf/layout/dedupe";
import { documentReadingOrder } from "@/lib/pdf/layout/document-reading-order";
import { layoutRegionSourceText } from "@/lib/pdf/layout/layout-translate";
import {
	isLayoutParagraphContinuation,
	normalizeLayoutSourceText,
} from "@/lib/pdf/layout/layout-translate-source";
import {
	attachLegendHeaders,
	bboxCoveredBy,
	LAYOUT_MERGE,
	mergeFormulasByNumber,
	selectClusterForTitle,
	unionBbox,
} from "@/lib/pdf/layout/merge-captions";
import { captionRoleFromText } from "@/lib/pdf/layout/title-text";
import type {
	LayoutTranslateItem,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";
import {
	reflowDisplayText,
	validReflowTranslation,
} from "@/lib/pdf/reflow/types";

export type ReadingBlock = {
	id: string;
	pageIndex: number;
	kind: PdfLayoutRegion["kind"];
	label?: string;
	bbox: PdfLayoutRegion["bbox"];
	readingOrder: number;
	source: string;
	text: string;
	translated?: string;
	item?: LayoutTranslateItem;
	image?: PdfLayoutRegion;
};
const VISUAL_KINDS: Partial<Record<PdfLayoutRegion["kind"], true>> = {
	image: true,
	chart: true,
	table: true,
	algorithm: true,
	formula: true,
	formula_number: true,
};

type FigureCaptionGroup = [] | [ReadingBlock, ReadingBlock];
const compactSource = (text: string) => text.replace(/[\s\u00ad-]/gu, "");

/** Remove document furniture by repeated margin text / model role, never by paper identity. */
function runningMatterIds(blocks: ReadingBlock[]): Set<string> {
	const key = (text: string) =>
		text.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
	const margins = blocks.filter(
		(b) =>
			!b.image &&
			((b.bbox.h < 0.06 && (b.bbox.y < 0.09 || b.bbox.y > 0.9)) ||
				(b.bbox.w < 0.04 && (b.bbox.x < 0.04 || b.bbox.x > 0.94))) &&
			b.label !== "doc_title" &&
			b.label !== "paragraph_title",
	);
	const repeated = margins.filter((b) =>
		margins.some(
			(other) =>
				other.pageIndex !== b.pageIndex && key(other.text) === key(b.text),
		),
	);
	// Author running heads can be extracted as text on only one later page.
	// Match their full name sequence against the front matter, tolerating
	// punctuation and affiliation markers while keeping the first-page line.
	const nameKey = (text: string) =>
		text
			.normalize("NFKC")
			.toLowerCase()
			.replace(/[^\p{L}\p{M}]/gu, "");
	const firstPage = Math.min(...blocks.map((b) => b.pageIndex));
	const frontMatter = new Set(
		blocks
			.filter(
				(b) =>
					!b.image &&
					b.pageIndex === firstPage &&
					b.bbox.y >= 0.09 &&
					b.bbox.y < 0.3 &&
					b.bbox.h < 0.08,
			)
			.map((b) => nameKey(b.text))
			.filter((text) => text.length >= 32),
	);
	return new Set(
		blocks
			.filter((b) => {
				if (b.image || b.label === "doc_title" || b.label === "paragraph_title")
					return false;
				if (repeated.includes(b)) return true;
				if (
					b.pageIndex > firstPage &&
					b.bbox.y < 0.09 &&
					b.bbox.h < 0.06 &&
					(b.kind === "header" || b.label === "header") &&
					frontMatter.has(nameKey(b.text))
				)
					return true;
				if (b.label === "footer" && b.bbox.y > 0.85) {
					// A short prose footnote may be labelled footer by the detector.
					// Keep its content and native citations; recurring margin text was
					// already handled above, and pagination is filtered separately.
					const numberedNote =
						/^\s*(?:\d{1,3}|[*†‡])\s*\p{L}/u.test(b.text) &&
						(b.text.match(/\p{L}+/gu)?.length ?? 0) >= 6;
					return !numberedNote;
				}
				if (b.bbox.y >= 0.2 || b.bbox.h > 0.08) return false;
				const text = key(b.text);
				return (
					(b.bbox.y < 0.12 &&
						text.length >= 16 &&
						repeated.some((r) => key(r.text).includes(text))) ||
					(b.label === "header" &&
						/^(?:contents lists? available|journal homepage\s*:)/i.test(b.text))
				);
			})
			.map((b) => b.id),
	);
}

/** Floats may interrupt physical columns, but not a sentence in continuous prose. */
function uninterruptedProse(blocks: ReadingBlock[]): ReadingBlock[] {
	const ordered = [...blocks];
	// Abstract metadata can sit in two short columns above the article body.
	// Keep those labelled rows with the abstract, before reading full columns.
	for (const abstract of blocks.filter((b) => b.kind === "abstract")) {
		const bottom = abstract.bbox.y + abstract.bbox.h;
		const metadata = ordered
			.filter(
				(b) =>
					b.pageIndex === abstract.pageIndex &&
					b.kind === "text" &&
					b.bbox.h < 0.05 &&
					b.bbox.y >= bottom - 0.005 &&
					b.bbox.y < bottom + 0.12 &&
					/^(?:doi|pacs|msc|keywords?|key\s+words|关键词|关键字)\s*[:：]/i.test(
						b.text,
					),
			)
			.sort((a, b) => a.bbox.y - b.bbox.y || a.bbox.x - b.bbox.x);
		for (const block of metadata) ordered.splice(ordered.indexOf(block), 1);
		ordered.splice(ordered.indexOf(abstract) + 1, 0, ...metadata);
	}
	for (let i = 0; i < ordered.length; i++) {
		const head = ordered[i];
		if (head.kind !== "text" && head.kind !== "abstract") continue;
		let next = i + 1;
		while (
			next < ordered.length &&
			ordered[next].pageIndex === head.pageIndex &&
			(ordered[next].kind === "figure_title" ||
				(ordered[next].image &&
					!["formula", "formula_number"].includes(ordered[next].kind)))
		)
			next++;
		const tail = ordered[next];
		if (
			next > i + 1 &&
			tail &&
			tail.pageIndex === head.pageIndex &&
			isLayoutParagraphContinuation(
				{ ...head, source: head.text },
				{ ...tail, source: tail.text },
			)
		) {
			ordered.splice(next, 1);
			ordered.splice(i + 1, 0, tail);
		}
	}
	// Footnotes remain available, after the page's main text instead of inside it.
	const pages = new Map<number, ReadingBlock[]>();
	for (const block of ordered) {
		const page = pages.get(block.pageIndex) ?? [];
		page.push(block);
		pages.set(block.pageIndex, page);
	}
	return [...pages.values()].flatMap((page) => [
		...page.filter((b) => b.label !== "footnote"),
		...page.filter((b) => b.label === "footnote"),
	]);
}

/** Printed pagination is layout chrome, not part of the continuous prose. */
function isPageMarker(block: ReadingBlock): boolean {
	if (block.image || VISUAL_KINDS[block.kind]) return false;
	const { y, h } = block.bbox;
	if (h > 0.06 || (y + h > 0.12 && y < 0.88)) return false;
	return /^(?:\d{1,4}|\d{4,8}\s*[-–]\s*\d{1,4}|[ivxlcdm]{1,8}|(?:page\s*)?\d{1,4}\s*(?:of|\/)\s*\d{1,4}|page\s+\d{1,4}|第\s*\d+\s*页(?:\s*[,，]\s*共\s*\d+\s*页)?)$/i.test(
		block.text.trim(),
	);
}

/** Keep a caption and its adjacent panel cluster in one reading-order band. */
function figureCaptionGroups(
	blocks: ReadingBlock[],
	regions: PdfLayoutRegion[],
	edgeEvidence: readonly PdfLayoutRegion[] = regions,
): Map<string, FigureCaptionGroup> {
	const groups = new Map<string, FigureCaptionGroup>();
	const claimed = new Set<string>();
	const figures = blocks.filter(
		(block): block is ReadingBlock & { image: PdfLayoutRegion } =>
			block.image !== undefined &&
			(block.kind === "image" || block.kind === "chart"),
	);
	const captions = blocks.filter(
		(b) =>
			!b.image &&
			b.kind === "figure_title" &&
			captionRoleFromText(b.text) === "figure_main",
	);
	const captionRegion = (b: ReadingBlock): PdfLayoutRegion => ({
		id: b.id,
		pageIndex: b.pageIndex,
		kind: b.kind,
		label: b.label ?? b.kind,
		score: 1,
		readingOrder: b.readingOrder,
		bbox: b.bbox,
		rect: { x: 0, y: 0, w: 0, h: 0 },
		title: b.text,
	});
	for (const caption of blocks) {
		if (!captions.includes(caption)) continue;
		const title = caption.bbox;
		const above = selectClusterForTitle(
			captionRegion(caption),
			figures
				.filter((f) => !claimed.has(f.id) && !f.image.titleBbox)
				.map((f) => f.image),
			captions.map(captionRegion),
			blocks.filter((b) => !b.image && b !== caption).map(captionRegion),
		);
		if (above.length) {
			const panels = above
				.map((r) => figures.find((f) => f.id === r.id))
				.filter((f): f is (typeof figures)[number] => !!f);
			const first = panels[0];
			const body = panels.reduce((b, p) => unionBbox(b, p.bbox), first.bbox);
			// Some figure headings and panel letters are embedded image pixels,
			// with no text layer. Keep their detected boxes in the image crop.
			const legends = attachLegendHeaders(
				body,
				captionRegion(caption),
				regions.filter((r) => r.kind === "figure_title"),
				caption.pageIndex,
				regions,
			);
			// Strong panel detections can miss a thin top strip (cables, labels).
			// A lower-confidence overlapping detection may extend that edge only
			// a small distance and never across independent body text.
			const edges = edgeEvidence.filter(
				(r) =>
					r.pageIndex === caption.pageIndex &&
					["image", "chart"].includes(r.kind) &&
					r.score >= 0.1 &&
					r.bbox.y < body.y &&
					body.y - r.bbox.y <= 0.03 &&
					bboxCoveredBy(r.bbox, body) >= 0.7 &&
					!blocks.some(
						(b) =>
							!b.image &&
							b.text.length > 100 &&
							b.pageIndex === caption.pageIndex &&
							b.bbox.y < body.y &&
							b.bbox.y + b.bbox.h > r.bbox.y &&
							bboxCoveredBy(b.bbox, r.bbox) > 0.5,
					),
			);
			const bbox = [...legends, ...edges].reduce(
				(b, r) => unionBbox(b, r.bbox),
				body,
			);
			const parts = [...panels.map((p) => p.image), ...legends, ...edges];
			const left = Math.min(...parts.map((p) => p.rect.x)),
				top = Math.min(...parts.map((p) => p.rect.y));
			const rect = {
				x: left,
				y: top,
				w: Math.max(...parts.map((p) => p.rect.x + p.rect.w)) - left,
				h: Math.max(...parts.map((p) => p.rect.y + p.rect.h)) - top,
			};
			groups.set(first.id, [
				{ ...first, bbox, image: { ...first.image, bbox, rect } },
				caption,
			]);
			for (const panel of panels) {
				claimed.add(panel.id);
				if (panel !== first) groups.set(panel.id, []);
			}
			for (const legend of legends) groups.set(legend.id, []);
			for (const label of blocks)
				if (
					!label.image &&
					label !== caption &&
					label.pageIndex === caption.pageIndex &&
					label.text.length < 100 &&
					label.bbox.h < 0.04 &&
					bboxCoveredBy(label.bbox, bbox) >= 0.85
				)
					groups.set(label.id, []);
			groups.set(caption.id, []);
			continue;
		}
		const row = figures.filter((figure) => {
			const box = figure.bbox;
			const overlap =
				Math.min(title.y + title.h, box.y + box.h) - Math.max(title.y, box.y);
			return (
				figure.pageIndex === caption.pageIndex &&
				!claimed.has(figure.id) &&
				!figure.image?.titleBbox &&
				overlap >= Math.min(title.h, box.h) * 0.5 &&
				(box.x >= title.x + title.w || box.x + box.w <= title.x)
			);
		});
		const gap = (box: ReadingBlock["bbox"]) =>
			Math.max(box.x - title.x - title.w, title.x - box.x - box.w);
		row.sort((a, b) => gap(a.bbox) - gap(b.bbox));
		const first = row[0];
		if (!first?.image || gap(first.bbox) > LAYOUT_MERGE.panelNeighborGap)
			continue;
		let bbox = first.bbox;
		const panels = [first];
		for (const next of row.slice(1)) {
			const box = next.bbox;
			if (box.x > title.x !== first.bbox.x > title.x) continue;
			const overlap =
				Math.min(bbox.y + bbox.h, box.y + box.h) - Math.max(bbox.y, box.y);
			if (
				overlap < Math.min(bbox.h, box.h) * 0.5 ||
				Math.max(box.x - bbox.x - bbox.w, bbox.x - box.x - box.w) >
					LAYOUT_MERGE.panelNeighborGap
			)
				continue;
			const combined = unionBbox(bbox, box);
			// A separate caption or prose between panels bounds the figure group.
			if (
				blocks.some(
					(block) =>
						block !== caption &&
						!block.image &&
						block.pageIndex === caption.pageIndex &&
						bboxCoveredBy(block.bbox, combined) > 0.1,
				)
			)
				continue;
			panels.push(next);
			bbox = combined;
		}
		for (const panel of panels) claimed.add(panel.id);
		const rect = panels.reduce(
			(bounds, panel) => ({
				x: Math.min(bounds.x, panel.image.rect.x),
				y: Math.min(bounds.y, panel.image.rect.y),
				w:
					Math.max(
						bounds.x + bounds.w,
						panel.image.rect.x + panel.image.rect.w,
					) - Math.min(bounds.x, panel.image.rect.x),
				h:
					Math.max(
						bounds.y + bounds.h,
						panel.image.rect.y + panel.image.rect.h,
					) - Math.min(bounds.y, panel.image.rect.y),
			}),
			first.image.rect,
		);
		groups.set(first.id, [
			{ ...first, bbox, image: { ...first.image, bbox, rect } },
			caption,
		]);
		for (const panel of panels.slice(1)) groups.set(panel.id, []);
		groups.set(caption.id, []);
	}
	return groups;
}

export function buildReadingBlocks(
	regions: readonly PdfLayoutRegion[],
	sources: readonly LayoutTranslateItem[],
	translations: readonly LayoutTranslateItem[] = [],
): ReadingBlock[] {
	// Keep small headings and equation numbers; the sidebar's minimum area is
	// intended for preview cards, not a complete reading surface.
	const selectedRegions = dedupeLayoutRegions([...regions], { minArea: 0 });
	const preparedByPage = new Map<number, LayoutTranslateItem[]>();
	for (const item of sources) {
		if (!item.reflow) continue;
		const page = preparedByPage.get(item.pageIndex);
		if (page) page.push(item);
		else preparedByPage.set(item.pageIndex, [item]);
	}
	// Protected formulas belong to their prose paragraph; formula-only paragraphs
	// still use the standalone crop. Both geometries here are page points.
	const inlineFormulaIds = new Set(
		selectedRegions
			.filter(
				(region) =>
					region.kind === "formula" &&
					sources.some((item) => {
						const paragraph = item.reflow;
						return (
							item.pageIndex === region.pageIndex &&
							paragraph &&
							/\p{L}/u.test(item.source.replace(/⟪(?:F|\/?S)\d+⟫/gu, "")) &&
							bboxCoveredBy(region.rect, paragraph.box) >= 0.85 &&
							paragraph.formulas.some(
								(formula) =>
									item.source.includes(`⟪F${formula.id}⟫`) &&
									// Model boxes may cover only part of a scripted ratio.
									(bboxCoveredBy(formula.box, region.rect) >= 0.5 ||
										bboxCoveredBy(region.rect, formula.box) >= 0.85),
							)
						);
					}),
			)
			.map((region) => region.id),
	);
	const numberedFormulas = mergeFormulasByNumber(
		selectedRegions.filter(
			(region) =>
				(region.kind === "formula" && !inlineFormulaIds.has(region.id)) ||
				region.kind === "formula_number",
		),
		true,
	);
	const readingRegions = selectedRegions
		.filter((region) => {
			if (
				(region.kind === "formula" || region.kind === "formula_number") &&
				selectedRegions.some(
					(other) =>
						other.pageIndex === region.pageIndex &&
						["image", "chart", "table", "algorithm"].includes(other.kind) &&
						bboxCoveredBy(region.bbox, other.bbox) >= 0.85,
				)
			)
				return false;
			if (inlineFormulaIds.has(region.id)) return false;
			if (region.kind === "formula_number")
				return !numberedFormulas.some((formula) => formula.id === region.id);
			if (region.kind === "formula")
				return !numberedFormulas.some(
					(formula) =>
						formula.pageIndex === region.pageIndex &&
						bboxCoveredBy(region.bbox, formula.bbox) >= 0.99,
				);
			return true;
		})
		.concat(
			numberedFormulas.filter(
				(region) =>
					!selectedRegions.some(
						(other) =>
							other.pageIndex === region.pageIndex &&
							["image", "chart", "table", "algorithm"].includes(other.kind) &&
							bboxCoveredBy(region.bbox, other.bbox) >= 0.85,
					),
			),
		);
	const visual = readingRegions.filter(
		(r) => VISUAL_KINDS[r.kind] && r.bbox.w > 0 && r.bbox.h > 0,
	);
	const sourceById = new Map(sources.map((item) => [item.id, item]));
	const blocks = new Map<string, ReadingBlock>();
	for (const region of readingRegions) {
		if (VISUAL_KINDS[region.kind]) {
			blocks.set(region.id, { ...region, source: "", text: "", image: region });
			continue;
		}
		const sourceItem = sourceById.get(region.id);
		const ocr = normalizeLayoutSourceText(
			layoutRegionSourceText(region),
			region.kind,
		);
		const overlaps =
			preparedByPage
				.get(region.pageIndex)
				?.filter(
					(item) =>
						bboxCoveredBy(item.bbox, region.bbox) >= 0.5 ||
						bboxCoveredBy(region.bbox, item.bbox) >= 0.5,
				) ?? [];
		const coveredText = overlaps
			.map((item) => compactSource(item.reflow?.source ?? ""))
			.join("");
		// Extraction claims each glyph once. An overlapping detection may own no
		// characters, so do not reinsert its OCR copy over the prepared paragraph.
		if (
			!sourceItem &&
			((!!ocr && coveredText.includes(compactSource(ocr))) ||
				overlaps.some((item) => {
					const overlap = bboxCoveredBy(region.bbox, item.bbox);
					return (
						overlap >= 0.85 ||
						(overlap >= 0.5 && !!ocr && item.reflow?.source.includes(ocr))
					);
				}))
		)
			continue;
		const source =
			sourceItem?.source ??
			normalizeLayoutSourceText(layoutRegionSourceText(region), region.kind);
		if (!source) continue;
		blocks.set(region.id, {
			...region,
			bbox: sourceItem?.bbox ?? region.bbox,
			source,
			text: sourceItem?.reflow
				? reflowDisplayText(sourceItem.reflow, source)
				: source,
			item: sourceItem,
		});
	}
	for (const item of sources) {
		if (blocks.has(item.id) || !item.source.trim()) continue;
		blocks.set(item.id, {
			...item,
			source: item.source,
			text: item.reflow
				? reflowDisplayText(item.reflow, item.source)
				: item.source,
			item,
		});
	}
	// A detector may call a short continuation (even half a word after a page
	// break) a paragraph title. Keep plain lowercase sentences as body text;
	// numbered headings and source-bold titles retain their hierarchy.
	for (const block of blocks.values()) {
		if (
			block.kind === "header" &&
			block.item?.reflow?.style.bold === false &&
			/^\p{Ll}/u.test(block.text) &&
			/[.!?]$/.test(block.text.trim())
		)
			block.kind = "text";
	}
	const furniture = runningMatterIds([...blocks.values()]);
	const codeIds = new Set<string>();
	for (const block of blocks.values()) {
		if (block.image || !["text", "header"].includes(block.kind)) continue;
		const paragraph = block.item?.reflow;
		const chars = paragraph?.characters.filter((c) => c.text.trim()) ?? [];
		const mono = chars.filter((c) =>
			/courier|mono|consolas|menlo|typewriter/i.test(c.style.font),
		);
		if (!chars.length || mono.length / chars.length < 0.85 || !paragraph)
			continue;
		// Code and aligned console text cannot use prose reflow: it removes
		// line breaks (including the end of // comments) and changes semantics.
		// Reuse the visual-block path and include glyphs just outside detector
		// bounds, such as an initial 'e' in endmodule or a leading underscore.
		const width = paragraph.box.w / block.bbox.w;
		const height = paragraph.box.h / block.bbox.h;
		if (!(width > 0 && height > 0)) continue;
		let bbox = block.bbox;
		for (const c of chars)
			bbox = unionBbox(bbox, {
				x: c.visualBox.x / width,
				y: c.visualBox.y / height,
				w: c.visualBox.w / width,
				h: c.visualBox.h / height,
			});
		block.kind = "algorithm";
		block.bbox = bbox;
		block.image = {
			id: block.id,
			pageIndex: block.pageIndex,
			kind: "algorithm",
			label: "algorithm",
			score: 1,
			readingOrder: block.readingOrder,
			bbox,
			rect: {
				x: bbox.x * width,
				y: bbox.y * height,
				w: bbox.w * width,
				h: bbox.h * height,
			},
		};
		codeIds.add(block.id);
	}
	// The detector can return both a whole code screenshot and text fragments
	// within it. Keep one crop, extending it to any owned glyphs at its edge.
	for (const id of codeIds) {
		const code = blocks.get(id);
		if (!code) continue;
		const host = [...blocks.values()].find(
			(b) =>
				b.image &&
				!codeIds.has(b.id) &&
				b.pageIndex === code.pageIndex &&
				["image", "algorithm"].includes(b.kind) &&
				bboxCoveredBy(code.bbox, b.bbox) >= 0.85,
		);
		if (!host?.image) continue;
		host.bbox = unionBbox(host.bbox, code.bbox);
		host.kind = "algorithm";
		host.image = {
			...host.image,
			kind: "algorithm",
			bbox: host.bbox,
			rect: unionBbox(host.image.rect, code.image?.rect ?? host.image.rect),
		};
		blocks.delete(id);
	}
	// Consecutive monospaced fragments belong to one visual block unless an
	// intervening caption/prose block or a column gap separates them.
	let prior: ReadingBlock | undefined;
	for (const code of [...blocks.values()]
		.filter((b) => codeIds.has(b.id))
		.sort((a, b) => a.pageIndex - b.pageIndex || a.bbox.y - b.bbox.y)) {
		const gap = prior ? code.bbox.y - prior.bbox.y - prior.bbox.h : Infinity;
		const joined = prior ? unionBbox(prior.bbox, code.bbox) : code.bbox;
		const previousBottom = prior ? prior.bbox.y + prior.bbox.h : 0;
		const interrupted =
			prior &&
			[...blocks.values()].some(
				(b) =>
					b.id !== prior?.id &&
					b.id !== code.id &&
					!codeIds.has(b.id) &&
					b.pageIndex === code.pageIndex &&
					b.bbox.y >= previousBottom - 0.002 &&
					b.bbox.y < code.bbox.y &&
					b.bbox.x < joined.x + joined.w &&
					b.bbox.x + b.bbox.w > joined.x,
			);
		if (
			prior?.image &&
			prior.pageIndex === code.pageIndex &&
			gap >= -0.03 &&
			gap <= 0.025 &&
			Math.abs(prior.bbox.x - code.bbox.x) < 0.04 &&
			!interrupted
		) {
			prior.bbox = joined;
			prior.image = {
				...prior.image,
				bbox: joined,
				rect: unionBbox(prior.image.rect, code.image?.rect ?? prior.image.rect),
			};
			prior.text += `\n${code.text}`;
			blocks.delete(code.id);
		} else prior = code;
	}
	const kept = [...blocks.values()].filter(
		(block) =>
			!isPageMarker(block) &&
			!furniture.has(block.id) &&
			(block.image ||
				!visual.some(
					(image) =>
						image.pageIndex === block.pageIndex &&
						(bboxCoveredBy(block.bbox, image.bbox) >= 0.85 ||
							// Line boxes include ascender/descent padding outside a
							// tight table crop. Only discard the duplicate when every
							// painted glyph is already preserved inside that crop.
							(image.kind === "table" &&
								(block.item?.reflow?.characters.some((c) => c.text.trim()) ??
									false) &&
								block.item?.reflow?.characters
									.filter((c) => c.text.trim())
									.every(
										(c) => bboxCoveredBy(c.visualBox, image.rect) >= 0.95,
									))),
				)),
	);
	const keptById = new Map(kept.map((block) => [block.id, block]));
	for (const candidate of translations) {
		const block = keptById.get(candidate.id);
		if (
			!block ||
			candidate.status !== "done" ||
			!candidate.translated?.trim() ||
			candidate.source !== block.source
		)
			continue;
		const paragraph = block.item?.reflow ?? candidate.reflow;
		if (paragraph && !validReflowTranslation(paragraph, candidate.translated))
			continue;
		block.translated = paragraph
			? reflowDisplayText(paragraph, candidate.translated)
			: candidate.translated;
		block.item = {
			...(block.item ?? candidate),
			translated: candidate.translated,
			sentences: candidate.sentences,
		};
	}
	const byId = new Map(kept.map((block) => [block.id, block]));
	const groups = figureCaptionGroups(kept, selectedRegions, regions);
	// Recovered paragraphs have no detector order. Start those pages in source
	// y order, then let the shared algorithm restore columns and spanning bands.
	const recoveredPages = new Set(
		kept
			.filter((block) => block.item?.reflow?.origin === "fallback")
			.map((block) => block.pageIndex),
	);
	const ordered = documentReadingOrder(
		kept.flatMap((block) => {
			const group = groups.get(block.id);
			if (group?.length === 0) return [];
			const bbox = group ? unionBbox(group[0].bbox, group[1].bbox) : block.bbox;
			return [
				{
					...block,
					bbox,
					readingOrder: recoveredPages.has(block.pageIndex)
						? bbox.y
						: block.readingOrder,
				},
			];
		}),
	);
	return uninterruptedProse(
		ordered.flatMap((region) => {
			const group = groups.get(region.id);
			if (group) return group;
			const block = byId.get(region.id);
			return block ? [block] : [];
		}),
	);
}
