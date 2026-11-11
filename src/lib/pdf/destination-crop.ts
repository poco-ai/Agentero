/**
 * Crop region for an in-text citation's destination — the bibliography entry a
 * `[N]` link jumps to — shown as an in-place preview when no structured
 * sidecar metadata is available.
 *
 * Prefers the destination page's text rects: group adjacent text into line
 * segments, find the line that opens entry N, and extend until the next entry
 * starts. The entry's own lines set its width, independently of the rest of
 * the page. Falls back to the layout region containing the anchor,
 * then to plain column geometry.
 */

import { clamp01 } from "@/lib/core/math";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";
import { groupLineSegments, type PageTextRect } from "@/lib/pdf/link-text";

export type PickDestinationRegionOptions = {
	pageIndex: number;
	pdfX: number | null;
	pdfY: number;
	pageWidthPt: number;
	pageHeightPt: number;
	regions?: readonly PdfLayoutRegion[];
	textRects?: readonly PageTextRect[];
	/** Bibliography number the link cites, when known. */
	entryIndex?: number | null;
	/**
	 * Last entry of a cited range (`[8–12]` → 12). The crop then spans from
	 * `entryIndex` through this entry.
	 */
	endEntryIndex?: number | null;
	/** /FitR targets may name only a page, not the numbered entry's position. */
	pageOnly?: boolean;
	/** Complete visible author/year citation, assembled from its native links. */
	citationText?: string;
	/** Exact entry start already established by visible author/year identity. */
	verifiedEntryStart?: boolean;
	/** Last line of a verified author heading, before the entry title. */
	verifiedHeadingBottom?: number;
};

export type DestinationCropRegion = {
	pageIndex: number;
	bbox: { x: number; y: number; w: number; h: number };
	/**
	 * True when a line opening entry `entryIndex` (`[N]` / `N.`) — or, for a
	 * range, any entry inside it — was found near the destination: proof the
	 * link really lands on a bibliography entry.
	 */
	entryMatched: boolean;
};

/** US Letter, used when the page size is unavailable. */
const DEFAULT_PAGE_WIDTH_PT = 612;
const DEFAULT_PAGE_HEIGHT_PT = 792;

// Empirical thresholds (PDF points unless noted), tuned on IEEE / ACM /
// USENIX / Springer bibliographies.
/** A detached entry label may start this far above / below its text. */
const LINE_CLUSTER_TOLERANCE_PT = 4;
/** Alignment tolerance for destinations just outside a hanging `[N]` label. */
const COLUMN_EDGE_SLACK_PT = 6;
/** PDF destinations may sit at the column margin, left of the entry label. */
const ANCHOR_X_SLACK_PT = 16;
/** Search radius around the destination y for the `[N]` / `N.` line. */
const ENTRY_SEARCH_RADIUS_PT = 120;
/** Without a marker, the nearest line must lie within this of the anchor. */
const ANCHOR_LINE_RADIUS_PT = 60;
/** Window above / below the anchor scanned for any entry-start line. */
const ANCHOR_WINDOW_ABOVE_PT = 16;
const ANCHOR_WINDOW_BELOW_PT = 24;
/** A vertical gap larger than this before the next entry ends a range. */
const RANGE_ENTRY_GAP_PT = 14;
/** Hard cap on one entry's height (~12–14 lines). */
const ENTRY_MAX_HEIGHT_PT = 160;
/** Allow a taller crop for a range: a base plus a per-entry allowance, capped. */
const RANGE_BASE_HEIGHT_PT = 200;
const RANGE_PER_ENTRY_PT = 80;
const RANGE_MAX_HEIGHT_PT = 650;
/** Lines this close to the entry's first-line x count as "back at margin". */
const HANGING_INDENT_SLACK_PT = 3;
/** Padding around the entry's text bounds. */
const CROP_PAD_X_PT = 6;
const CROP_PAD_Y_PT = 5;

// Normalized (0–1 of the page) limits.
const CROP_MAX_W = 0.96;
const CROP_MIN_H = 0.02;
const CROP_MAX_H = 0.3;
const RANGE_CROP_MAX_H = 0.65;
/** Crops stay inside this page margin. */
const PAGE_EDGE = 0.98;
/** Height of the geometry-only fallback crop. */
const FALLBACK_H = 0.12;

/**
 * Labelled bibliography entry starts:
 * - [1], [ 1 ], [12] (bracketed numbers)
 * - [ABC24], [DEF+25], [Ghi26] (bracketed alphanumeric keys — always with
 *   year digits, so IEEE's "[Online]. Available: …" continuation is not one)
 * - 1., 12. (dot-numbered)
 */
const LABELLED_ENTRY_START_REGEX =
	/^\s*(?:\[\s*\d+\s*\]|\(\s*[1-9]\d{0,2}\s*\)|\[[A-Za-z+]*\d[A-Za-z0-9+]*\]|\d{1,3}\s?\.(?=\s|\p{L}))/u;
/** A detached entry label may sit further from its text than an ordinary word. */
const ENTRY_LABEL_ONLY_REGEX =
	/^\s*(?:\[\s*\d+\s*\]|\(\s*[1-9]\d{0,2}\s*\)|\[[A-Za-z+]*\d[A-Za-z0-9+]*\]|\d{1,3}\s?\.)\s*$/;
/**
 * Author-year entry starts: "Author et al., 2024", "Writer (2025)". Only used
 * in bibliographies without labels — in a labelled one, continuation lines
 * such as "USA, 2017, pp. 2123–2138." would match too.
 */
const AUTHOR_YEAR_ENTRY_START_REGEX =
	/^\s*(?:[\p{Lu}][\p{L}\p{M}'’-]+(?:\s+et\s+al\.)?,?\s+\(?\s*(?:18|19|20)\d{2}|[\p{Lu}][\p{L}\p{M}'’-]+,\s*[\p{Lu}][\p{L}\p{M}\s.,&’'-]*\(?\s*(?:18|19|20)\d{2}|[\p{Lu}][\p{L}\p{M}'’-]+(?:\s+(?:of|the|for|and|[\p{Lu}][\p{L}\p{M}'’-]+))*\.\s+(?:18|19|20)\d{2})/u;

/** Entry-start test for one column's lines, by its bibliography style. */
function entryStartTest(
	lines: readonly TextLine[],
	authorYear = false,
): (line: TextLine) => boolean {
	const headingText = (text: string) =>
		text
			.replace(/^([\p{Lu}][\p{L}\p{M}'’\s-]+)(?=,\s*\p{Lu})/u, (name) =>
				name.replace(/\s/g, ""),
			)
			.replace(/(?<!\d)((?:1\s*[89]|2\s*0)\s*\d\s*\d)(?!\d)/g, (year) =>
				year.replace(/\s/g, ""),
			);
	const labelled =
		!authorYear && lines.some((l) => LABELLED_ENTRY_START_REGEX.test(l.text));
	const wrappedAuthorYear = (line: TextLine) => {
		if (!/^[\p{Lu}][\p{L}\p{M}\s.,&’'()…-]+$/u.test(line.text)) return false;
		// A wrapped URL filename is not an author list. In particular, its
		// following bibliography entry must not supply the filename's year.
		if (/\.\p{Ll}{2,}/u.test(line.text)) return false;
		const heading = [line];
		for (const next of lines) {
			const previous = heading[heading.length - 1];
			if (
				next.minY <= previous.minY ||
				next.minX < line.minX - ANCHOR_X_SLACK_PT ||
				next.minX > line.minX + ANCHOR_X_SLACK_PT * 2 ||
				next.minY - previous.maxY > (line.maxY - line.minY) * 1.5
			)
				continue;
			// A publisher/title tail cannot borrow the year of the next complete
			// author heading. Wrapped personal author lists have a comma followed
			// by a name; a trailing comma in prose is not that evidence.
			if (
				(AUTHOR_YEAR_ENTRY_START_REGEX.test(headingText(next.text)) ||
					/^\p{Lu}[\p{L}\p{M}'’\s-]+,\s*\p{Lu}/u.test(next.text)) &&
				!/,\s*\p{Lu}/u.test(line.text)
			)
				return false;
			heading.push(next);
			const headingMatch =
				/^([\p{L}\p{M}\s.,&’'()…-]+)\b(?:18|19|20)\d{2}/u.exec(
					headingText(heading.map((l) => l.text).join(" ")),
				);
			if (headingMatch)
				return (
					/,\s*\p{Lu}/u.test(headingMatch[1]) ||
					/\.\s*\(?\s*$/u.test(headingMatch[1])
				);
			if (heading.length >= 16 || next.minY - line.minY > ENTRY_MAX_HEIGHT_PT)
				break;
		}
		return false;
	};
	const authorYearStart = (line: TextLine) =>
		AUTHOR_YEAR_ENTRY_START_REGEX.test(headingText(line.text)) ||
		/^\p{Lu}(?:\s+\p{Lu}[\p{L}\p{M}'’-]*)+\.\s*\(?\s*(?:18|19|20)\d{2}/u.test(
			headingText(line.text),
		) ||
		/^\p{Lu}[\p{L}\p{M}'’\s-]+,\s*(?:eds?|trans)\.\s*\(?\s*(?:18|19|20)\d{2}/u.test(
			headingText(line.text),
		) ||
		wrappedAuthorYear(line);
	// Some bibliographies indent the first line instead of the continuations.
	// The preceding entry's flush-left tail must not disqualify those authors.
	const firstLineIndent = (line: TextLine) =>
		lines.some(
			(next) =>
				next.minY > line.minY &&
				next.minY - line.maxY < line.maxY - line.minY &&
				line.minX - next.minX > HANGING_INDENT_SLACK_PT &&
				line.minX - next.minX <= ANCHOR_X_SLACK_PT &&
				!authorYearStart(next),
		);
	return labelled
		? (line) => LABELLED_ENTRY_START_REGEX.test(line.text)
		: (line) =>
				authorYearStart(line) &&
				(firstLineIndent(line) ||
					!lines.some(
						(previous) =>
							previous.minY < line.minY - LINE_CLUSTER_TOLERANCE_PT &&
							line.minY - previous.minY <= ENTRY_SEARCH_RADIUS_PT &&
							line.minX - previous.minX > HANGING_INDENT_SLACK_PT &&
							line.minX - previous.minX <= ANCHOR_X_SLACK_PT,
					));
}

/**
 * Line that opens bibliography entry `n`: `[n]`, `[n:` or `n. `. Rects are
 * joined with spaces, so the number and its dot may arrive as `n .`.
 */
function entryMarkerRegex(n: number): RegExp {
	return new RegExp(
		`^\\s*(?:\\[\\s*${n}\\s*[\\]:]|\\(\\s*${n}\\s*\\)|${n}\\s?\\.(?=\\s|\\p{L}))`,
		"u",
	);
}

/** Bibliography number an entry line opens with (`[12] …` / `12. …`). */
function leadingEntryNumber(text: string): number | null {
	const m = /^\s*[[(]?\s*(\d+)/.exec(text);
	return m ? Number.parseInt(m[1] ?? "", 10) : null;
}

/** Whether layout regions show a narrow right-hand column. */
function hasTwoColumnRegions(
	regions: readonly PdfLayoutRegion[] | undefined,
): boolean {
	return regions?.some((r) => r.bbox.x >= 0.48 && r.bbox.w < 0.5) ?? false;
}

type TextLine = {
	minY: number;
	maxY: number;
	minX: number;
	maxX: number;
	text: string;
};

/** Keep separate columns on the same baseline, joining detached entry labels. */
function entrySegments(rects: readonly PageTextRect[]): TextLine[] {
	const raised = new Map<TextLine, number>();
	const lines = groupLineSegments(rects)
		.map((segment) => {
			const line = {
				minY: segment.coreTop,
				maxY: segment.coreBottom,
				minX: segment.left,
				maxX: segment.right,
				text: segment.glyphs.map((glyph) => glyph.ch).join(""),
			};
			// Some publishers place raised numbers before authors without a dot.
			const prefix = /^(\d{1,3})(?=\p{L})/u.exec(line.text);
			if (prefix) {
				const end = segment.glyphs[prefix[1].length - 1].x1;
				const digits = rects.filter(
					(r) =>
						/^\d+$/.test(r.content) &&
						r.rect.origin.x >= line.minX &&
						r.rect.origin.x < end &&
						Math.abs(r.rect.origin.y - line.minY) < segment.height,
				);
				if (
					digits.length &&
					digits.every(
						(r) =>
							line.maxY - r.rect.origin.y - r.rect.size.height >=
							segment.height * 0.2,
					)
				)
					raised.set(line, Number(prefix[1]));
			}
			return line;
		})
		.sort((a, b) => a.minY - b.minY || a.minX - b.minX);
	const joined = new Set<TextLine>();
	// Raised labels with similar-sized ink boxes can form a separate segment.
	// Join only a directly adjacent, lower author line; sequential labels below
	// must still confirm that this is a numbered bibliography.
	for (const label of lines) {
		if (!/^\d{1,3}$/.test(label.text)) continue;
		const next = lines.find((line) => {
			const height = line.maxY - line.minY;
			return (
				!joined.has(line) &&
				/^\p{L}/u.test(line.text) &&
				line.minX >= label.maxX &&
				line.minX - label.maxX <= height &&
				line.minY > label.minY &&
				line.minY < label.maxY &&
				line.maxY - label.maxY >= height * 0.2
			);
		});
		if (!next) continue;
		raised.set(label, Number(label.text));
		label.text += next.text;
		label.maxY = next.maxY;
		label.maxX = next.maxX;
		joined.add(next);
	}
	// Sequential neighbours at the same margin distinguish bibliography
	// labels from exponents or an isolated numbered heading.
	for (const [line, number] of raised)
		if (
			[...raised].some(
				([other, n]) =>
					Math.abs(n - number) === 1 &&
					Math.abs(other.minX - line.minX) <= ANCHOR_X_SLACK_PT &&
					Math.abs(other.minY - line.minY) <= ENTRY_SEARCH_RADIUS_PT,
			)
		)
			line.text = line.text.replace(/^\d{1,3}/, `${number}. `);
	for (const label of lines) {
		if (!ENTRY_LABEL_ONLY_REGEX.test(label.text)) continue;
		const next = lines
			.filter(
				(line) =>
					!joined.has(line) &&
					line.minX >= label.maxX &&
					Math.abs(line.minY - label.minY) <= LINE_CLUSTER_TOLERANCE_PT,
			)
			.sort((a, b) => a.minX - b.minX)[0];
		if (
			!next ||
			ENTRY_LABEL_ONLY_REGEX.test(next.text) ||
			next.minX - label.maxX > (next.maxY - next.minY) * 4
		) {
			continue;
		}
		label.text += ` ${next.text}`;
		label.minY = Math.min(label.minY, next.minY);
		label.maxY = Math.max(label.maxY, next.maxY);
		label.maxX = next.maxX;
		joined.add(next);
	}
	return lines.filter((line) => !joined.has(line));
}

/** Once the column is known, join all runs on a row, including spaced URLs. */
function clusterLines(rects: readonly PageTextRect[]): TextLine[] {
	const clusters: { yCenter: number; rects: PageTextRect[] }[] = [];
	for (const r of [...rects].sort(
		(a, b) => a.rect.origin.y - b.rect.origin.y,
	)) {
		const center = r.rect.origin.y + r.rect.size.height / 2;
		const line = clusters.find(
			(c) => Math.abs(c.yCenter - center) <= LINE_CLUSTER_TOLERANCE_PT,
		);
		if (line) {
			line.rects.push(r);
			line.yCenter += (center - line.yCenter) / line.rects.length;
		} else {
			clusters.push({ yCenter: center, rects: [r] });
		}
	}
	return clusters
		.map(({ rects: row }) => {
			row.sort((a, b) => a.rect.origin.x - b.rect.origin.x);
			return {
				minY: Math.min(...row.map((r) => r.rect.origin.y)),
				maxY: Math.max(...row.map((r) => r.rect.origin.y + r.rect.size.height)),
				minX: Math.min(...row.map((r) => r.rect.origin.x)),
				maxX: Math.max(...row.map((r) => r.rect.origin.x + r.rect.size.width)),
				// Join using actual spacing. Inserting a space between every
				// character changes `14.` into `1 4 .` and hides the range boundary.
				text: groupLineSegments(row)
					.sort((a, b) => a.left - b.left)
					.map((s) => s.glyphs.map((g) => g.ch).join(""))
					.join(" "),
			};
		})
		.sort((a, b) => a.minY - b.minY);
}

/** Only use explicit authors plus year; a BibTeX key is not display metadata. */
function authorYearIdentity(text: string | undefined) {
	const match = text
		?.trim()
		.match(/^(.+?)\s*[,;(]?\s*((?:18|19|20)\d{2}[a-z]?)\s*[).,;]*$/i);
	if (!match) return null;
	const authorText = match[1].replace(/\bet\s+al\.?/gi, "").trim();
	const authors = authorText.split(/\s*(?:,|\band\b|&)\s*/).filter(Boolean);
	if (
		!authors.length ||
		authors.some((a) => !/^[\p{L}\p{M}'’´`().\-\s]+$/u.test(a))
	)
		return null;
	return {
		authors: authors.map((author) =>
			normalizeAuthor(author.replace(/\s+(?:Jr|Sr)\.?$/i, "")),
		),
		acronym: authors.length === 1 && /^[A-Z]{2,12}$/.test(authors[0]),
		year: match[2].toLowerCase(),
	};
}

function normalizeAuthor(text: string): string {
	return text
		.normalize("NFKD")
		.replace(/[\p{M}´`]/gu, "")
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, " ")
		.trim();
}

function singleLetterDifference(a: string, b: string): boolean {
	if (Math.min(a.length, b.length) < 7 || Math.abs(a.length - b.length) > 1)
		return false;
	let i = 0,
		j = 0,
		differences = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			i++;
			j++;
			continue;
		}
		if (++differences > 1) return false;
		if (a.length >= b.length) i++;
		if (b.length >= a.length) j++;
	}
	return differences + a.length - i + b.length - j === 1;
}

/** Restore justified headings whose word gaps formed separate segments.
 * Repeated full-width line margins delimit columns, even when their gutter is
 * narrower than a justified word gap. Only bibliography matching uses this. */
function authorYearLines(rects: readonly PageTextRect[]): TextLine[] {
	const segments = entrySegments(rects);
	const joined: TextLine[] = [];
	for (const segment of segments) {
		const previous = joined[joined.length - 1];
		const height = segment.maxY - segment.minY;
		const columnStart = segments.some(
			(other) =>
				other !== segment &&
				Math.abs(other.minX - segment.minX) <= ANCHOR_X_SLACK_PT &&
				other.maxX - other.minX >= height * 15 &&
				Math.abs(other.minY - segment.minY) > LINE_CLUSTER_TOLERANCE_PT &&
				Math.abs(other.minY - segment.minY) <= ENTRY_SEARCH_RADIUS_PT,
		);
		if (
			previous &&
			Math.abs(previous.minY - segment.minY) <= LINE_CLUSTER_TOLERANCE_PT &&
			segment.minX >= previous.maxX - 1 &&
			segment.minX - previous.maxX <= height * 4 &&
			(!columnStart || segment.minX - previous.minX < height * 8)
		) {
			previous.text += ` ${segment.text}`;
			previous.maxX = Math.max(previous.maxX, segment.maxX);
			previous.maxY = Math.max(previous.maxY, segment.maxY);
		} else joined.push({ ...segment });
	}
	return joined.map((line) => ({
		...line,
		text: line.text.replace(
			/(?<!\d)((?:1\s*[89]|2\s*0)\s*\d\s*\d)(?!\d)/g,
			(year) => year.replace(/\s/g, ""),
		),
	}));
}

/** A unique author list and publication year can recover a stale XYZ anchor.
 * Stay on its original target page; never infer another page from a fuzzy key. */
function authorYearDestination(
	options: PickDestinationRegionOptions,
): PickDestinationRegionOptions | null {
	const identity = authorYearIdentity(options.citationText);
	if (!identity || !options.textRects?.length) return null;
	const lines = authorYearLines(options.textRects);
	const candidates = lines.flatMap((start) => {
		if (
			/^(?:references|bibliography|literaturecited|workscited)$/i.test(
				start.text.replace(/\s/g, ""),
			)
		)
			return [];
		// Author lists may wrap. Only join close, indented continuation lines in
		// this column, and stop at the first year (before the title/journal).
		const entry = [start];
		for (const line of lines) {
			const previous = entry[entry.length - 1];
			if (line.minY <= previous.minY + LINE_CLUSTER_TOLERANCE_PT) continue;
			if (
				line.minY - start.minY > ENTRY_MAX_HEIGHT_PT ||
				line.minX < start.minX - HANGING_INDENT_SLACK_PT ||
				line.minX > start.minX + ANCHOR_X_SLACK_PT * 2 ||
				line.minY - previous.maxY > (start.maxY - start.minY) * 1.5
			)
				continue;
			if (
				entry.some((part) => /(?:18|19|20)\d{2}/.test(part.text)) &&
				line.minX <= start.minX + HANGING_INDENT_SLACK_PT &&
				AUTHOR_YEAR_ENTRY_START_REGEX.test(line.text)
			)
				break;
			entry.push(line);
			if (entry.length >= 16) break;
		}
		const heading = entry.map((l) => l.text).join(" ");
		let year = /(?<!\d)((?:18|19|20)\d{2}[a-z]?)(?!\d)/i.exec(heading);
		if (!year) return [];
		// A report title may end in a year immediately before its publication
		// year. Keep that second date only when it is explicitly the cited year.
		const followingYear = /^[\s.,;()]+((?:18|19|20)\d{2}[a-z]?)(?!\d)/i.exec(
			heading.slice(year.index + year[0].length),
		);
		if (followingYear?.[1].toLowerCase() === identity.year) {
			const index =
				year.index +
				year[0].length +
				followingYear[0].indexOf(followingYear[1]);
			year = Object.assign([followingYear[1], followingYear[1]], {
				index,
			}) as RegExpExecArray;
		}
		const authorHeading = heading.slice(0, year.index);
		const firstAuthor = normalizeAuthor(
			authorHeading.split(/,|(?<=\p{L}{2})\.(?=\s+\p{Lu})/u)[0] ?? "",
		);
		const compact = (text: string) => text.replace(/\s/g, "");
		const first = compact(identity.authors[0]);
		// Personal names use surname-before-comma or given-name-first. An
		// institutional author may contain conjunctions, so compare its complete
		// heading prefix as well. Whitespace in PDF text is not authoritative.
		const acronymMatches =
			identity.acronym &&
			(compact(firstAuthor).startsWith(first) ||
				firstAuthor
					.split(/\s+/)
					.filter((word) => !/^(?:of|the|and|for|in)$/.test(word))
					.map((word) => word[0])
					.join("") === first);
		const exactFirst =
			compact(firstAuthor) === first ||
			firstAuthor.endsWith(` ${identity.authors[0]}`) ||
			acronymMatches ||
			(identity.authors.length > 1 &&
				compact(normalizeAuthor(authorHeading)).startsWith(first));
		const authors = compact(normalizeAuthor(authorHeading));
		const exactAuthors =
			exactFirst &&
			(acronymMatches ||
				identity.authors.every((author) => authors.includes(compact(author))));
		const exactYear = year[1].toLowerCase() === identity.year;
		// Some native-linked citations list editors, omit the lead author, or
		// include the name of a scale. Require every cited name in this entry,
		// an exact year, and a nearby native anchor before using that evidence.
		const nearAnchor =
			Math.abs(start.minY - (options.pageHeightPt - options.pdfY)) <=
				ANCHOR_WINDOW_BELOW_PT &&
			(options.pdfX == null ||
				options.pdfX <= 0 ||
				Math.abs(start.minX - options.pdfX) <= ANCHOR_X_SLACK_PT);
		const entryNames = compact(normalizeAuthor(heading));
		const alternateAuthors =
			exactYear &&
			nearAnchor &&
			identity.authors.length > 1 &&
			identity.authors.every((author) => entryNames.includes(compact(author)));
		// A native bibliography link plus a unique identity can resolve a minor
		// source typo. Never relax author AND year, short surnames, or year suffixes.
		const typoAuthor =
			exactYear &&
			identity.authors.length === 1 &&
			singleLetterDifference(compact(firstAuthor), first);
		const adjacentYear =
			exactAuthors &&
			/^\d{4}$/.test(identity.year) &&
			/^\d{4}$/.test(year[1]) &&
			Math.abs(Number(year[1]) - Number(identity.year)) === 1;
		let count = 0;
		const yearLine =
			entry.find((line) => {
				count += line.text.length + 1;
				return count > year.index;
			}) ?? start;
		return exactAuthors || typoAuthor || alternateAuthors
			? [
					{
						start,
						headingBottom: yearLine.maxY,
						exact: (exactAuthors && exactYear) || alternateAuthors,
						relaxed: typoAuthor || adjacentYear,
					},
				]
			: [];
	});
	const exact = candidates.filter((c) => c.exact);
	const matches = exact.length ? exact : candidates.filter((c) => c.relaxed);
	let match = matches.length === 1 ? matches[0] : undefined;
	if (!match && exact.length > 1) {
		const targetY = options.pageHeightPt - options.pdfY;
		const ranked = exact
			.map((candidate) => ({
				candidate,
				distance: Math.abs(candidate.start.minY - targetY),
			}))
			.sort((a, b) => a.distance - b.distance);
		const nearby = ranked.filter(
			({ candidate: { start }, distance }) =>
				distance <= ANCHOR_WINDOW_ABOVE_PT &&
				(options.pdfX == null ||
					options.pdfX <= 0 ||
					Math.abs(start.minX - options.pdfX) <= ANCHOR_X_SLACK_PT),
		);
		if (
			nearby.length === 1 ||
			(nearby.length > 1 && nearby[1].distance - nearby[0].distance > 2)
		)
			match = nearby[0].candidate;
	}
	if (!match) return null;
	const start = match.start;
	return {
		...options,
		pdfX: start.minX,
		pdfY: options.pageHeightPt - start.minY,
		verifiedEntryStart: true,
		verifiedHeadingBottom: match.headingBottom,
	};
}

function nearestLine(lines: readonly TextLine[], y: number): TextLine {
	return lines.reduce((best, l) =>
		Math.abs(l.minY - y) < Math.abs(best.minY - y) ? l : best,
	);
}

/** Clamp a normalized crop so it keeps its size and stays on the page. */
function clampCrop(
	x: number,
	y: number,
	w: number,
	h: number,
): { x: number; y: number; w: number; h: number } {
	const width = Math.min(w, PAGE_EDGE);
	const height = Math.min(h, PAGE_EDGE);
	return {
		x: Math.min(clamp01(x), PAGE_EDGE - width),
		y: Math.min(clamp01(y), PAGE_EDGE - height),
		w: width,
		h: height,
	};
}

/** Crop the entry from the destination page's text lines, or null. */
function cropFromText(
	textRects: readonly PageTextRect[],
	options: {
		wPt: number;
		hPt: number;
		targetYPt: number;
		normX: number | null;
		entryIndex?: number | null;
		endEntryIndex?: number | null;
		pageOnly?: boolean;
		verifiedEntryStart?: boolean;
		verifiedHeadingBottom?: number;
	},
): { bbox: DestinationCropRegion["bbox"]; entryMatched: boolean } | null {
	const { wPt, hPt, targetYPt, normX, entryIndex } = options;
	const range =
		entryIndex != null &&
		options.endEntryIndex != null &&
		options.endEntryIndex > entryIndex
			? { start: entryIndex, end: options.endEntryIndex }
			: null;
	// Rotated side watermarks span many rows and otherwise connect them all.
	const validRects = textRects.filter(
		(r) => r.content && r.rect.size.height <= ENTRY_MAX_HEIGHT_PT,
	);
	const allLines =
		options.entryIndex == null
			? authorYearLines(validRects)
			: entrySegments(validRects);
	const anchorX = normX != null ? normX * wPt : null;
	const anchorLines =
		anchorX != null
			? allLines.filter(
					(line) =>
						line.minX <= anchorX + ANCHOR_X_SLACK_PT &&
						line.maxX >= anchorX - COLUMN_EDGE_SLACK_PT,
				)
			: allLines;
	const candidates = anchorLines.length ? anchorLines : allLines;
	if (candidates.length === 0) return null;
	// Anchor candidates omit hanging-indented rows. Entry recognition still
	// needs those rows to find the year at the end of a wrapped author list;
	// entryStartTest applies its own column/alignment checks.
	const isEntryStart = entryStartTest(allLines, options.verifiedEntryStart);

	const marker = entryIndex != null ? entryMarkerRegex(entryIndex) : null;
	const numberedMatches = marker
		? allLines.filter((line) => marker.test(line.text))
		: [];
	// Some XYZ anchors retain a position from before the bibliography was
	// typeset into columns. Accept a distant unique number only with a nearby
	// sequential entry at the same margin; an isolated numbered line or a
	// repeated label is not enough evidence to override the destination.
	const verifiedNumber =
		numberedMatches.length === 1 &&
		allLines.some(
			(line) =>
				line !== numberedMatches[0] &&
				LABELLED_ENTRY_START_REGEX.test(line.text) &&
				Math.abs(
					(leadingEntryNumber(line.text) ?? -Infinity) - (entryIndex ?? 0),
				) === 1 &&
				Math.abs(line.minX - numberedMatches[0].minX) <= ANCHOR_X_SLACK_PT &&
				Math.abs(line.minY - numberedMatches[0].minY) <= ENTRY_SEARCH_RADIUS_PT,
		);
	// Publishers may point every bibliography link at the page top (/FitR).
	// A unique explicit entry number is stronger evidence than that coordinate.
	const exactCandidates = marker
		? numberedMatches.filter(
				(l) =>
					options.pageOnly ||
					verifiedNumber ||
					(range
						? l.minY <= targetYPt + ANCHOR_WINDOW_BELOW_PT &&
							targetYPt - l.minY <= hPt
						: Math.abs(l.minY - targetYPt) <= ENTRY_SEARCH_RADIUS_PT),
			)
		: [];
	// The range's first entry is on an earlier page / column: start at the
	// first entry of the range present here.
	const inRangeCandidates =
		range && exactCandidates.length === 0
			? candidates.filter((l) => {
					if (!isEntryStart(l)) return false;
					const n = leadingEntryNumber(l.text);
					return (
						n != null &&
						n >= range.start &&
						n <= range.end &&
						Math.abs(l.minY - targetYPt) <= hPt
					);
				})
			: [];
	const entryMatched =
		exactCandidates.length > 0 || inRangeCandidates.length > 0;

	let startLine: TextLine;
	if (options.verifiedEntryStart) {
		startLine = nearestLine(candidates, targetYPt);
	} else if (exactCandidates.length > 0) {
		startLine = nearestLine(exactCandidates, targetYPt);
	} else if (inRangeCandidates[0]) {
		startLine = inRangeCandidates[0];
	} else {
		const markerCandidates = candidates.filter(
			(l) =>
				l.maxY >= targetYPt - ANCHOR_WINDOW_ABOVE_PT &&
				l.minY <= targetYPt + ANCHOR_WINDOW_BELOW_PT &&
				isEntryStart(l),
		);
		startLine = nearestLine(
			markerCandidates.length > 0 ? markerCandidates : candidates,
			targetYPt,
		);
	}

	// Nearby entry margins distinguish neighbouring columns. The first row may
	// end early or split before a URL, so its width cannot bound wrapped rows.
	const nearbyEntries = allLines.filter(
		(line) =>
			isEntryStart(line) &&
			Math.abs(line.minY - startLine.minY) <= ENTRY_SEARCH_RADIUS_PT,
	);
	const columnEntries = nearbyEntries.filter(
		(line) => Math.abs(line.minX - startLine.minX) <= ANCHOR_X_SLACK_PT,
	);
	const columnLeft = Math.min(
		startLine.minX,
		...columnEntries.map((line) => line.minX),
	);
	const columnExtent = Math.max(
		startLine.maxX,
		...columnEntries.map((line) => line.maxX),
	);
	// The other column may still contain prose or equations. Repeated margins
	// there distinguish it from a detached URL run on this entry's first row.
	const neighbours = allLines.filter(
		(line) =>
			Math.abs(line.minY - startLine.minY) <= ENTRY_SEARCH_RADIUS_PT &&
			line.minX > columnExtent + COLUMN_EDGE_SLACK_PT,
	);
	const sharesEntryRow = (line: TextLine) =>
		columnEntries.some(
			(entry) => Math.abs(entry.minY - line.minY) <= LINE_CLUSTER_TOLERANCE_PT,
		);
	const columnRight = Math.min(
		wPt,
		...nearbyEntries
			.filter((line) => line.minX > startLine.maxX + COLUMN_EDGE_SLACK_PT)
			.map((line) => line.minX),
		...neighbours
			.filter((line) =>
				neighbours.some(
					(other) =>
						other !== line &&
						Math.abs(other.minX - line.minX) <= ANCHOR_X_SLACK_PT &&
						Math.abs(other.minY - line.minY) > LINE_CLUSTER_TOLERANCE_PT &&
						Math.abs(other.minY - line.minY) <= ENTRY_SEARCH_RADIUS_PT &&
						(!sharesEntryRow(line) || !sharesEntryRow(other)),
				),
			)
			.map((line) => line.minX),
	);
	const lines = clusterLines(
		validRects.filter(
			(r) =>
				r.rect.origin.x >= columnLeft - COLUMN_EDGE_SLACK_PT &&
				r.rect.origin.x < columnRight,
		),
	);
	if (lines.length === 0) return null;
	startLine = nearestLine(lines, startLine.minY);
	const startIdx = lines.indexOf(startLine);
	if (
		startIdx < 0 ||
		(!entryMatched &&
			Math.abs(startLine.minY - targetYPt) > ANCHOR_LINE_RADIUS_PT)
	) {
		return null;
	}

	const entryLines = [startLine];
	const startHasMarker = isEntryStart(startLine);
	const baseLeftX = startLine.minX;
	const firstContinuation = lines[startIdx + 1];
	const hangingIndent =
		firstContinuation != null &&
		!isEntryStart(firstContinuation) &&
		firstContinuation.minX > baseLeftX + HANGING_INDENT_SLACK_PT;
	for (let i = startIdx + 1; i < lines.length; i++) {
		const prev = lines[i - 1];
		const curr = lines[i];
		if (!prev || !curr) break;
		// Wrapped lines of one entry sit tight (≤ ~half a line apart); a gap
		// over a full line ends the bibliography. Entries of a range may sit
		// further apart.
		const gapLimit = isEntryStart(curr)
			? RANGE_ENTRY_GAP_PT
			: startLine.maxY - startLine.minY;
		if (curr.minY - prev.maxY > gapLimit) break;
		// The next entry starts — unless it is still inside the cited range.
		if (
			isEntryStart(curr) &&
			curr.minY > (options.verifiedHeadingBottom ?? -Infinity)
		) {
			const n = range ? leadingEntryNumber(curr.text) : null;
			if (n == null || !range || n < range.start || n > range.end) break;
		}
		// Without a marker the entry uses a hanging indent; back at the
		// margin means a new paragraph / entry.
		if (
			!range &&
			!startHasMarker &&
			!options.verifiedEntryStart &&
			curr.minX <= baseLeftX + HANGING_INDENT_SLACK_PT &&
			i > startIdx + 1
		) {
			break;
		}
		// Enforce a hanging margin only when the entry actually uses one.
		// Dot-numbered bibliographies can keep every continuation flush left.
		if (
			startHasMarker &&
			hangingIndent &&
			!isEntryStart(curr) &&
			curr.minX <= baseLeftX + HANGING_INDENT_SLACK_PT
		) {
			break;
		}
		const maxHeight = range
			? Math.min(
					RANGE_MAX_HEIGHT_PT,
					RANGE_BASE_HEIGHT_PT + (range.end - range.start) * RANGE_PER_ENTRY_PT,
				)
			: ENTRY_MAX_HEIGHT_PT;
		if (curr.maxY - startLine.minY > maxHeight) break;
		entryLines.push(curr);
	}

	const minX = Math.min(...entryLines.map((l) => l.minX));
	const maxX = Math.max(...entryLines.map((l) => l.maxX));
	const minY = Math.min(...entryLines.map((l) => l.minY));
	const maxY = Math.max(...entryLines.map((l) => l.maxY));

	// Pad, but never into the neighbouring lines.
	const nextLine = lines[startIdx + entryLines.length];
	const prevLine = startIdx > 0 ? lines[startIdx - 1] : undefined;
	const rawCropTop = Math.max(0, minY - CROP_PAD_Y_PT);
	const rawCropBottom = Math.min(hPt, maxY + CROP_PAD_Y_PT);
	const cropTop =
		prevLine != null
			? Math.min(minY, Math.max(prevLine.maxY + 1, rawCropTop))
			: rawCropTop;
	const cropBottom =
		nextLine != null
			? Math.max(maxY, Math.min(nextLine.minY - 1, rawCropBottom))
			: rawCropBottom;
	const cropLeft = Math.max(0, minX - CROP_PAD_X_PT);
	const cropRight = Math.min(wPt, maxX + CROP_PAD_X_PT);

	const w = Math.min(CROP_MAX_W, (cropRight - cropLeft) / wPt);
	// The minimum height must not reach into the next entry.
	const maxBottom = nextLine != null ? nextLine.minY - 1 : hPt;
	const h = Math.min(
		Math.max(
			CROP_MIN_H,
			Math.min(
				range ? RANGE_CROP_MAX_H : CROP_MAX_H,
				(cropBottom - cropTop) / hPt,
			),
		),
		Math.max(cropBottom, maxBottom) / hPt - cropTop / hPt,
	);
	return {
		bbox: clampCrop(cropLeft / wPt, cropTop / hPt, w, h),
		entryMatched,
	};
}

/** Crop the layout region containing the anchor, clamped to one column. */
function cropFromLayout(
	pageIndex: number,
	regions: readonly PdfLayoutRegion[] | undefined,
	normX: number | null,
	normY: number,
): DestinationCropRegion["bbox"] | null {
	const containing = (regions ?? []).filter((r) => {
		if (r.pageIndex !== pageIndex) return false;
		const inY = normY >= r.bbox.y - 0.02 && normY <= r.bbox.y + r.bbox.h + 0.02;
		if (!inY) return false;
		if (normX == null) return true;
		return normX >= r.bbox.x - 0.02 && normX <= r.bbox.x + r.bbox.w + 0.02;
	});
	const region =
		normX != null && containing.length > 1
			? containing.reduce((best, r) =>
					Math.abs(r.bbox.x - normX) < Math.abs(best.bbox.x - normX) ? r : best,
				)
			: containing[0];
	if (!region || region.bbox.w < 0.2) return null;

	// Two columns only when a real right-hand column block exists (not a
	// narrow caption / figure in a single-column paper).
	const twoColumn =
		(regions ?? []).some(
			(r) =>
				r.pageIndex === pageIndex &&
				r !== region &&
				r.bbox.x >= 0.48 &&
				r.bbox.w >= 0.25 &&
				r.bbox.h >= 0.1,
		) ||
		(regions ?? []).some(
			(r) => r.bbox.x >= 0.48 && r.bbox.w >= 0.3 && r.bbox.h >= 0.15,
		);
	let x = region.bbox.x;
	let w = region.bbox.w;
	// A full-width region on a two-column page: keep the anchor's column only.
	if (twoColumn && w > 0.52) {
		if (normX != null && normX >= 0.48) {
			x = 0.5;
			w = 0.46;
		} else {
			x = Math.max(0.04, region.bbox.x);
			w = Math.min(0.44, 0.5 - x);
		}
	}
	const y = Math.max(0.01, normY - 0.015);
	return { x, y, w, h: Math.min(FALLBACK_H, PAGE_EDGE - y) };
}

/** Last resort: a strip below the anchor in its (guessed) column. */
function cropFromGeometry(
	regions: readonly PdfLayoutRegion[] | undefined,
	normX: number | null,
	normY: number,
): DestinationCropRegion["bbox"] {
	const y = Math.max(0.01, normY - 0.015);
	const h = Math.min(FALLBACK_H, PAGE_EDGE - y);
	let x = 0.06;
	let w = 0.88;
	if (normX != null) {
		if (normX >= 0.45) {
			x = Math.max(0.48, normX - 0.02);
			w = Math.min(0.46, PAGE_EDGE - x);
		} else if (hasTwoColumnRegions(regions) || normX > 0.05) {
			x = Math.max(0.04, normX - 0.02);
			w = Math.min(0.46, 0.48 - x + 0.02);
		}
	}
	return { x, y, w, h };
}

/**
 * Normalized crop for an internal link destination (an in-text citation whose
 * structured metadata lookup failed). Text rects isolate exactly the entry;
 * layout regions and column geometry are fallbacks.
 */
export function pickDestinationRegion({
	pageIndex,
	pdfX,
	pdfY,
	pageWidthPt,
	pageHeightPt,
	regions,
	textRects,
	entryIndex,
	endEntryIndex,
	pageOnly,
	verifiedEntryStart,
	verifiedHeadingBottom,
}: PickDestinationRegionOptions): DestinationCropRegion {
	const wPt = pageWidthPt > 0 ? pageWidthPt : DEFAULT_PAGE_WIDTH_PT;
	const hPt = pageHeightPt > 0 ? pageHeightPt : DEFAULT_PAGE_HEIGHT_PT;
	// pdfY is PDF space (origin bottom-left); text rects and renderPageRect use
	// device space (origin top-left).
	const targetYPt = hPt - (pdfY > 0 ? pdfY : hPt * 0.9);
	const normX = pdfX != null && pdfX > 0 ? clamp01(pdfX / wPt) : null;
	const normY = clamp01(targetYPt / hPt);

	if (textRects && textRects.length > 0) {
		const fromText = cropFromText(textRects, {
			wPt,
			hPt,
			targetYPt,
			normX,
			entryIndex,
			endEntryIndex,
			pageOnly,
			verifiedEntryStart,
			verifiedHeadingBottom,
		});
		if (fromText) return { pageIndex, ...fromText };
	}
	const bbox =
		cropFromLayout(pageIndex, regions, normX, normY) ??
		cropFromGeometry(regions, normX, normY);
	return { pageIndex, bbox, entryMatched: false };
}

/** Numbered ranges can cross columns: return only the requested entries,
 * in numeric order, instead of one rectangle containing unrelated text. */
export function pickDestinationRegions(
	options: PickDestinationRegionOptions,
): DestinationCropRegion[] {
	if (
		options.entryIndex == null &&
		/^\s*\(?\s*(?:18|19|20)\d{2}[a-z]?\s*\)?\s*$/i.test(
			options.citationText ?? "",
		)
	)
		return [];
	if (options.entryIndex == null && authorYearIdentity(options.citationText)) {
		const destination = authorYearDestination(options);
		if (!destination) return [];
		return [{ ...pickDestinationRegion(destination), entryMatched: true }];
	}
	const start = options.entryIndex;
	const end = options.endEntryIndex;
	if (start == null || end == null || end <= start || end - start > 30)
		return [pickDestinationRegion(options)];
	// First validate the range against the original destination. Once it is
	// known to land on this bibliography, its entries may be far above the
	// anchor or in the other column, beyond the singleton search radius.
	if (!pickDestinationRegion(options).entryMatched) return [];
	const entries: DestinationCropRegion[] = [];
	for (let entryIndex = start; entryIndex <= end; entryIndex++) {
		const crop = pickDestinationRegion({
			...options,
			entryIndex,
			endEntryIndex: null,
			pageOnly: true,
		});
		if (crop.entryMatched) entries.push(crop);
	}
	return entries;
}

/** Continue a verified entry only at a column/page boundary. The next
 * bibliography heading bounds the leading continuation; an ordinary new
 * entry or page header must never be appended to the hovered reference. */
export function pickDestinationContinuation(
	crop: DestinationCropRegion,
	source: PickDestinationRegionOptions,
	target: PickDestinationRegionOptions,
): DestinationCropRegion | null {
	if (!crop.entryMatched || !source.textRects || !target.textRects) return null;
	const sourceWidth = source.pageWidthPt,
		sourceHeight = source.pageHeightPt;
	const left = crop.bbox.x * sourceWidth;
	const right = (crop.bbox.x + crop.bbox.w) * sourceWidth;
	const bottom = (crop.bbox.y + crop.bbox.h) * sourceHeight;
	if (bottom < sourceHeight * 0.7) return null;
	const sourceLines = authorYearLines(source.textRects);
	const own = sourceLines.filter(
		(l) =>
			l.minY >= crop.bbox.y * sourceHeight &&
			l.maxY <= bottom + 1 &&
			l.minX >= left &&
			l.maxX <= right + 1,
	);
	if (!own.length) return null;
	const height = Math.max(...own.map((l) => l.maxY - l.minY));
	const body = (line: TextLine, pageHeight: number) =>
		line.minY >= pageHeight * 0.04 &&
		line.maxY <= pageHeight * 0.96 &&
		line.maxY - line.minY >= height * 0.65 &&
		line.maxY - line.minY <= height * 1.6;
	const rows = sourceLines.filter((l) => body(l, sourceHeight));
	if (rows.some((l) => l.minX >= left && l.minX < right && l.minY > bottom))
		return null;
	const rightColumn = rows.filter(
		(l) => l.minX > right && l.maxX - l.minX > height * 6,
	);
	const samePage = target.pageIndex === source.pageIndex;
	if (
		samePage
			? !rightColumn.length
			: rightColumn.length > 0 || target.pageIndex !== source.pageIndex + 1
	)
		return null;
	const targetLines = authorYearLines(target.textRects).filter((l) =>
		body(l, target.pageHeightPt),
	);
	const candidates = samePage
		? targetLines.filter((l) => l.minX > right)
		: targetLines;
	if (!candidates.length) return null;
	const margin = Math.min(...candidates.map((l) => l.minX));
	const width = right - left;
	// The source crop's padding and hanging indent are not the next page's
	// column width. Repeated full-width rows establish its actual gutter.
	const neighbouringColumn = candidates.filter(
		(line) =>
			line.minX > margin + width * 0.7 &&
			line.maxX - line.minX > height * 6 &&
			candidates.some(
				(other) =>
					other !== line &&
					Math.abs(other.minX - line.minX) <= ANCHOR_X_SLACK_PT &&
					Math.abs(other.minY - line.minY) > LINE_CLUSTER_TOLERANCE_PT,
			),
	);
	const columnRight = Math.min(
		margin + width + ANCHOR_X_SLACK_PT,
		...neighbouringColumn.map((line) => line.minX),
	);
	const column = clusterLines(
		target.textRects.filter(
			(r) => r.rect.origin.x >= margin - 1 && r.rect.origin.x < columnRight,
		),
	).filter((l) => body(l, target.pageHeightPt));
	const isEntry = entryStartTest(column, source.entryIndex == null);
	const nextIndex = column.findIndex(isEntry);
	if (nextIndex <= 0) return null;
	const lines = column.slice(0, nextIndex),
		next = column[nextIndex];
	if (lines[0].minY > target.pageHeightPt * 0.22 || lines.length > 24)
		return null;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i],
			after = column[i + 1];
		if (
			Math.abs(line.minX - next.minX) > ANCHOR_X_SLACK_PT * 2 ||
			after.minY - line.maxY > height * 1.5
		)
			return null;
	}
	const x = Math.max(0, Math.min(...lines.map((l) => l.minX)) - CROP_PAD_X_PT);
	const y = Math.max(0, lines[0].minY - CROP_PAD_Y_PT);
	const lastLine = lines[lines.length - 1];
	const end = Math.max(
		lastLine.maxY,
		Math.min(next.minY - 1, lastLine.maxY + CROP_PAD_Y_PT),
	);
	return {
		pageIndex: target.pageIndex,
		entryMatched: true,
		bbox: {
			x: x / target.pageWidthPt,
			y: y / target.pageHeightPt,
			w:
				(Math.min(
					target.pageWidthPt,
					Math.max(...lines.map((l) => l.maxX)) + CROP_PAD_X_PT,
				) -
					x) /
				target.pageWidthPt,
			h: (end - y) / target.pageHeightPt,
		},
	};
}
