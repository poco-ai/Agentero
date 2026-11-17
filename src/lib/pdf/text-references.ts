/** Local text fallback for publishers without usable citation link annotations. */
import type { Rect } from "@embedpdf/models";
import type { Citation } from "@/lib/paper/refs";
import {
	type CrossrefLabel,
	extractCrossrefLabel,
} from "@/lib/pdf/crossref-resolve";
import {
	groupLineSegments,
	type LineSegment,
	type PageTextRect,
} from "@/lib/pdf/link-text";

export type TextReference = {
	text: string;
	rect: Rect;
	numbers?: number[];
	authorYears?: { author: string; year: string }[];
	label?: CrossrefLabel;
};

const DASH = "[-‐‑‒–—−]";
const NUMBER_GROUP = new RegExp(
	`^\\s*\\d+(?:\\s*${DASH}\\s*\\d+)?(?:\\s*,\\s*\\d+(?:\\s*${DASH}\\s*\\d+)?)*\\s*$`,
);
const YEAR = /\b(?:18|19|20)\d{2}[a-z]?\b/gu;

export function citationNumbers(text: string): number[] {
	const body = text.replace(/^[[［]|[\]］]$/g, "");
	if (!NUMBER_GROUP.test(body)) return [];
	const result = new Set<number>();
	for (const part of body.split(",")) {
		const bounds = part
			.trim()
			.split(new RegExp(`\\s*${DASH}\\s*`))
			.map(Number);
		const first = bounds[0],
			last = bounds[1] ?? first;
		if (!first || first > last || last - first > 30 || last > 9999) return [];
		for (let n = first; n <= last; n++) result.add(n);
	}
	return [...result];
}

function normalize(text: string): string {
	return text.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
}

export function citationAuthors(
	text: string,
): NonNullable<TextReference["authorYears"]> {
	const result: NonNullable<TextReference["authorYears"]> = [];
	for (const part of text.replace(/^[（(]|[）)]$/g, "").split(";")) {
		const year = [...part.matchAll(YEAR)][0];
		if (!year) continue;
		const before = part.slice(0, year.index).trim();
		const author = before.match(
			/^([\p{L}][\p{L}'’‐–-]*(?:\s+(?:de|van|von|der)\s+[\p{L}'’‐–-]+)?)/u,
		)?.[1];
		if (author) result.push({ author, year: year[0] });
	}
	return result;
}

/** Every candidate is retained when author/year alone cannot disambiguate. */
export function matchTextReference(
	reference: TextReference,
	citations: readonly Citation[],
): Citation[] {
	if (reference.numbers)
		return reference.numbers.flatMap((n) =>
			citations.filter(
				(c) =>
					c.display?.trim() === `[${n}]` ||
					c.id === `ref-${n}` ||
					c.id === `ref${n}`,
			),
		);
	return (reference.authorYears ?? []).flatMap(({ author, year }) =>
		citations.filter((c) => {
			const raw = c.raw ?? "";
			const years = [...raw.matchAll(YEAR)].map((m) => m[0]);
			if (
				String(c.metadata.year) !== year.replace(/[a-z]$/, "") &&
				!years.includes(year)
			)
				return false;
			if (/[a-z]$/.test(year) && years.length && !years.includes(year))
				return false;
			// Enrichment can prepend a consortium / organization to the authors.
			// The original bibliography's first author remains a valid identity;
			// arbitrary later coauthors do not establish an author-year citation.
			const names = [
				c.metadata.authors?.[0],
				raw.replace(/^\s*(?:\[\d+\]|\d+\.)\s*/, "").split(/[,.(]/)[0],
			];
			return names.some(
				(name) =>
					name &&
					normalize(name)
						.split(/[^\p{L}'’-]+/u)
						.includes(normalize(author)),
			);
		}),
	);
}

/** Column-local order; never concatenate the ends of neighbouring columns. */
export function referenceLines(rects: readonly PageTextRect[]): LineSegment[] {
	// PDFium may include a linked number in both the preceding text run and
	// its own shorter run. Keep the latter's actual hit geometry, trimming only
	// repeated suffixes whose boxes overlap on the same baseline.
	const unique = rects.map((run) => {
		const { origin, size } = run.rect;
		const right = origin.x + size.width;
		const duplicate = rects.find((other) => {
			const suffix = other.content.trim();
			const b = other.rect;
			const overlap =
				Math.min(origin.y + size.height, b.origin.y + b.size.height) -
				Math.max(origin.y, b.origin.y);
			return (
				other !== run &&
				suffix.length > 0 &&
				suffix.length <= 16 &&
				run.content.trimEnd().length > suffix.length &&
				run.content.trimEnd().endsWith(suffix) &&
				b.origin.x > origin.x &&
				b.origin.x <= right &&
				b.origin.x + b.size.width >= right &&
				b.origin.x >= right - b.size.width - 1 &&
				overlap >= Math.min(size.height, b.size.height) * 0.7 &&
				((b.origin.x < right &&
					(/^\s/u.test(other.content) ||
						right - b.origin.x >= b.size.width * 0.5)) ||
					(b.size.height < size.height * 0.9 &&
						run.content.endsWith(other.content)))
			);
		});
		if (!duplicate) return run;
		return {
			...run,
			content: run.content.trimEnd().slice(0, -duplicate.content.trim().length),
			rect: {
				origin,
				size: { ...size, width: duplicate.rect.origin.x - origin.x },
			},
		};
	});
	const lines = groupLineSegments(unique);
	const min = Math.min(...lines.map((l) => l.left)),
		max = Math.max(...lines.map((l) => l.right));
	const middle = (min + max) / 2;
	const twoColumns =
		lines.some((l) => l.left > middle) && lines.some((l) => l.right < middle);
	return lines.sort(
		(a, b) =>
			(twoColumns ? Number(a.left > middle) - Number(b.left > middle) : 0) ||
			a.coreTop - b.coreTop ||
			a.left - b.left,
	);
}

function lineText(line: LineSegment): string {
	return line.glyphs.map((g) => g.ch).join("");
}

/** Wrapped groups produce one hit rectangle per line, all sharing the full group. */
export function detectTextReferences(
	rects: readonly PageTextRect[],
): TextReference[] {
	const lines = referenceLines(rects);
	const blocks: LineSegment[][] = [];
	for (const line of lines) {
		const block = blocks.at(-1),
			previous = block?.at(-1);
		if (
			previous &&
			line.coreTop > previous.coreTop &&
			line.coreTop - previous.coreTop < 2.5 * previous.height &&
			Math.min(line.right, previous.right) > Math.max(line.left, previous.left)
		)
			block?.push(line);
		else blocks.push([line]);
	}
	const output: TextReference[] = [];
	for (const block of blocks) {
		let text = "";
		const spans = block.map((line) => {
			const start = text.length;
			text += `${lineText(line)}\n`;
			return { line, start, end: text.length - 1 };
		});
		const pattern =
			/[[［][\d\s,‐‑‒–—−-]+[\]］]|[（(][^()（）]{0,600}?(?:18|19|20)\d{2}[^()（）]{0,300}?[）)]|\b(?:Fig(?:ure)?s?\.?|Tables?|Tbl\.?)\s*\d+[a-z]?(?:\s*[,–-]\s*[a-z](?![\p{L}\p{N}]))*/giu;
		for (const match of text.matchAll(pattern)) {
			const numbers = citationNumbers(match[0]);
			const authorYears = numbers.length ? [] : citationAuthors(match[0]);
			const label =
				numbers.length || authorYears.length
					? null
					: extractCrossrefLabel(match[0]);
			if (!numbers.length && !authorYears.length && !label) continue;
			for (const { line, start, end } of spans) {
				const from = Math.max(match.index, start),
					to = Math.min(match.index + match[0].length, end);
				if (from >= to) continue;
				const glyphs = line.glyphs.slice(from - start, to - start);
				const first = glyphs[0],
					last = glyphs.at(-1);
				if (!first || !last) continue;
				output.push({
					text: match[0],
					rect: {
						origin: { x: first.x0, y: line.coreTop },
						size: {
							width: last.x1 - first.x0,
							height: line.height,
						},
					},
					...(numbers.length
						? { numbers }
						: authorYears.length
							? { authorYears }
							: label
								? { label }
								: {}),
				});
			}
		}
	}
	// Raised numeric runs: require a larger body run immediately to their left.
	// This excludes ordinary years, numbered lists, dimensions and page numbers.
	const numericRuns = groupLineSegments(
		rects.filter((r) => /^[\d\s,‐‑‒–—−-]+$/.test(r.content)),
	).map((line) => ({
		content: lineText(line),
		rect: {
			origin: { x: line.left, y: line.coreTop },
			size: { width: line.right - line.left, height: line.height },
		},
	}));
	for (const run of numericRuns) {
		const numbers = citationNumbers(run.content);
		if (
			!numbers.length ||
			output.some((r) => referenceRectsOverlap(r.rect, run.rect))
		)
			continue;
		const { origin: p, size: s } = run.rect;
		const raised = rects.some(
			({ rect: b, content }) =>
				/\p{L}/u.test(content) &&
				s.height < b.size.height * 0.86 &&
				p.x >= b.origin.x + b.size.width - 1 &&
				p.x - b.origin.x - b.size.width < b.size.height &&
				p.y + s.height < b.origin.y + b.size.height * 0.9 &&
				p.y > b.origin.y - b.size.height * 0.5,
		);
		if (raised) output.push({ text: run.content, rect: run.rect, numbers });
	}
	return output;
}

export function referenceRectsOverlap(a: Rect, b: Rect): boolean {
	return (
		Math.min(a.origin.x + a.size.width, b.origin.x + b.size.width) >
			Math.max(a.origin.x, b.origin.x) &&
		Math.min(a.origin.y + a.size.height, b.origin.y + b.size.height) >
			Math.max(a.origin.y, b.origin.y)
	);
}

export const REFERENCE_HEADING =
	/^\s*(?:\d+\.?\s*)?(?:references|bibliography|literature cited)\s*$/i;
export type BibliographyEntry = {
	citation: Citation;
	pageIndex: number;
	rect: Rect;
};

/** Read only the bibliography, after a References heading has been located. */
export function bibliographyEntries(
	pages: readonly { pageIndex: number; rects: readonly PageTextRect[] }[],
): BibliographyEntry[] {
	const entries: BibliographyEntry[] = [];
	let active = false,
		current: BibliographyEntry | null = null;
	for (const { pageIndex, rects } of pages)
		for (const line of referenceLines(rects)) {
			const text = lineText(line).trim();
			if (REFERENCE_HEADING.test(text)) {
				active = true;
				continue;
			}
			if (!active) continue;
			if (
				/^(?:appendix|supporting information|supplementary materials?)\b/i.test(
					text,
				)
			) {
				active = false;
				current = null;
				continue;
			}
			const number = text.match(/^\s*(?:\[\s*(\d+)\s*\]|(\d+)\s*\.\s)/);
			const author = /^[\p{Lu}][\p{L}'’‐-]+,\s*[\p{Lu}](?:\.|\b)/u.test(text);
			if (number || author) {
				const n = number?.[1] ?? number?.[2];
				current = {
					pageIndex,
					rect: {
						origin: { x: line.left, y: line.coreTop },
						size: { width: line.right - line.left, height: line.height },
					},
					citation: {
						id: n ? `ref-${n}` : `pdf-ref-${entries.length}`,
						display: n ? `[${n}]` : undefined,
						raw: text,
						metadata: {},
						source: "pdf-text",
						status: "unresolved",
					},
				};
				entries.push(current);
			} else if (current && text.length > 3) current.citation.raw += ` ${text}`;
		}
	for (const { citation } of entries) {
		const raw = citation.raw ?? "";
		const year = [...raw.matchAll(YEAR)][0]?.[0];
		const doi = raw
			.match(/\b10\.\d{4,9}\/[^\s<>]+/i)?.[0]
			.replace(/[.,;]+$/, "");
		citation.metadata = {
			...(year ? { year: Number.parseInt(year, 10) } : {}),
			...(doi ? { doi } : {}),
		};
	}
	return entries;
}
