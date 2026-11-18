/**
 * Read the annotation text that was written into a user message at send time.
 * History display strips that appendix; the preview must use this copy, not
 * the paper's current marks. A later edit or delete of the original annotation
 * does not change what was stored on the message.
 *
 * Two shapes land in the stored prompt:
 * - `## Annotation N` sections after {@link ANNOTATION_APPENDIX_LEAD}
 *   (non-vault quotes and visual page / comment)
 * - Host context blocks before `User request:` (`Annotation N` + `Quoted text:`)
 *   for vault quotes, which are not repeated in the appendix
 */
import { ANNOTATION_APPENDIX_LEAD } from "@/lib/agent/annotation-prompt";

export type AnnotationSnapshot = {
	n: number;
	kind: "text" | "visual";
	/** Quoted passage, without `>` prefixes. */
	quote?: string;
	/** User comment, without the prompt label. `(no comment)` is omitted. */
	comment?: string;
	/** Location or title written next to the quote. */
	source?: string;
	page?: number;
	/** Paired translation captured with the quote. */
	translation?: string;
};

const USER_REQUEST_MARKER = "User request:\n";
const SKILL_TAILS = [
	"\n\n## Skill:",
	"\n\n# Skill:",
	"\n\n### Skill:",
	"\n\n<skill",
	"\n\nActive skills use the $ trigger",
	"\n\nActive skills use the / trigger",
	"\n\nAgentero injects skill instructions",
] as const;

const HOST_FIELDS = [
	"Paper ref:",
	"Paper path:",
	"File:",
	"Directory:",
	"Title:",
	"Page:",
	"Section:",
	"Lines:",
	"Line:",
	"Citation:",
	"Quoted text:",
	"User comment on this quote only:",
	"Before quote (excerpt):",
	"After quote (excerpt):",
	"Translation of the quoted sentences:",
	"The quote above is truncated.",
] as const;

const MARKER_RE = /\[Annotation (\d+)\]/g;
const APPENDIX_HEADING_RE = /^## Annotation (\d+)\s*$/gm;
const HOST_HEADING_RE = /^Annotation (\d+)\s*$/gm;

function cutSkillTail(text: string): string {
	let end = text.length;
	for (const marker of SKILL_TAILS) {
		const at = text.indexOf(marker);
		if (at >= 0 && at < end) end = at;
	}
	return text.slice(0, end);
}

function pageFromSource(source: string | undefined): number | undefined {
	const match = source?.match(/\(page (\d+)\)/);
	if (!match) return undefined;
	const page = Number(match[1]);
	return page >= 1 ? page : undefined;
}

function cleanComment(text: string | undefined): string | undefined {
	const value = text?.trim();
	if (!value || value === "(no comment)" || value === "(no text)")
		return undefined;
	return value;
}

/** Snapshots in ascending number order. Empty when the message has no appendix. */
export function annotationSnapshotsFromMessage(
	raw: string,
): AnnotationSnapshot[] {
	if (!raw.trim()) return [];
	const text = raw.replace(/\r\n/g, "\n");
	const byN = new Map<number, AnnotationSnapshot>();
	const appendixAt = text.lastIndexOf(ANNOTATION_APPENDIX_LEAD);
	if (appendixAt >= 0) {
		parseAppendixSections(cutSkillTail(text.slice(appendixAt)), byN);
	}
	parseHostAnnotationBlocks(text, byN);
	return [...byN.values()].sort((a, b) => a.n - b.n);
}

/**
 * Cards for `[Annotation N]` markers in the visible bubble, in first-seen order.
 * A number with no snapshot is skipped. The raw message wins over a previously
 * stored parse; the stored list is only for text that was already stripped.
 */
export function annotationSnapshotsForMarkers(
	visibleText: string,
	rawText: string,
	stored?: readonly AnnotationSnapshot[] | null,
): AnnotationSnapshot[] {
	const numbers = annotationNumbersInText(visibleText);
	if (numbers.length === 0) return [];
	const parsed = rawText.trim() ? annotationSnapshotsFromMessage(rawText) : [];
	const source = parsed.length > 0 ? parsed : (stored ?? []);
	if (source.length === 0) return [];
	const byN = new Map(source.map((item) => [item.n, item]));
	const cards: AnnotationSnapshot[] = [];
	for (const n of numbers) {
		const snapshot = byN.get(n);
		if (snapshot) cards.push(snapshot);
	}
	return cards;
}

export function annotationNumbersInText(text: string): number[] {
	const seen = new Set<number>();
	const out: number[] = [];
	for (const match of text.matchAll(MARKER_RE)) {
		const n = Number(match[1]);
		if (!Number.isInteger(n) || n < 1 || seen.has(n)) continue;
		seen.add(n);
		out.push(n);
	}
	return out;
}

/** Plain copy of the cards the bubble is showing. */
export function formatAnnotationSnapshotsForCopy(
	snapshots: readonly AnnotationSnapshot[],
): string {
	return snapshots
		.map((snapshot) => {
			const lines = [`[Annotation ${snapshot.n}]`];
			if (snapshot.source) lines.push(snapshot.source);
			if (snapshot.page) lines.push(`page ${snapshot.page}`);
			if (snapshot.quote) lines.push(snapshot.quote);
			if (snapshot.translation) lines.push(snapshot.translation);
			if (snapshot.comment) lines.push(snapshot.comment);
			return lines.join("\n");
		})
		.join("\n\n");
}

function parseAppendixSections(
	appendix: string,
	byN: Map<number, AnnotationSnapshot>,
) {
	const matches = [...appendix.matchAll(APPENDIX_HEADING_RE)];
	for (let i = 0; i < matches.length; i++) {
		const n = Number(matches[i][1]);
		if (!Number.isInteger(n) || n < 1 || byN.has(n)) continue;
		const start = (matches[i].index ?? 0) + matches[i][0].length;
		const end =
			i + 1 < matches.length
				? (matches[i + 1].index ?? appendix.length)
				: appendix.length;
		const snapshot = parseAppendixBody(n, appendix.slice(start, end).trim());
		if (snapshot) byN.set(n, snapshot);
	}
}

function parseAppendixBody(n: number, body: string): AnnotationSnapshot | null {
	if (!body) return null;
	if (body.startsWith("Visual annotation")) return parseVisualBody(n, body);
	if (body.startsWith("Selected text from "))
		return parseSelectedTextBody(n, body);
	return null;
}

function parseVisualBody(n: number, body: string): AnnotationSnapshot {
	const lines = body.split("\n");
	const pageMatch = lines[0]?.match(/^Visual annotation — page (\d+)\s*$/);
	const page =
		pageMatch && Number(pageMatch[1]) >= 1 ? Number(pageMatch[1]) : undefined;
	const commentLines: string[] = [];
	let inComment = false;
	for (const line of lines) {
		if (!inComment) {
			if (line.startsWith("User comment:")) {
				inComment = true;
				const first = line.slice("User comment:".length).trim();
				if (first) commentLines.push(first);
			}
			continue;
		}
		if (line.trim() === "Crop image is not attached.") break;
		commentLines.push(line);
	}
	return {
		n,
		kind: "visual",
		page,
		comment: cleanComment(commentLines.join("\n")),
	};
}

function parseSelectedTextBody(
	n: number,
	body: string,
): AnnotationSnapshot | null {
	const lines = body.split("\n");
	const header = lines[0] ?? "";
	if (!header.startsWith("Selected text from ") || !header.endsWith(":")) {
		return null;
	}
	const source = header.slice("Selected text from ".length, -1).trim();
	let index = 1;
	while (index < lines.length && lines[index].trim() === "") index += 1;
	const quoted: string[] = [];
	while (
		index < lines.length &&
		(lines[index].startsWith("> ") || lines[index] === ">")
	) {
		quoted.push(lines[index] === ">" ? "" : lines[index].slice(2));
		index += 1;
	}
	const quote = quoted.join("\n").trim() || undefined;
	while (index < lines.length && lines[index].trim() === "") index += 1;
	let comment: string | undefined;
	if (lines[index]?.startsWith("User comment on this selection:")) {
		const first = lines[index]
			.slice("User comment on this selection:".length)
			.trim();
		index += 1;
		const commentLines = first ? [first] : [];
		while (index < lines.length && !isAuxiliaryLine(lines[index])) {
			commentLines.push(lines[index]);
			index += 1;
		}
		comment = cleanComment(commentLines.join("\n"));
	}
	const translation = translationFrom(lines.slice(index).join("\n"));
	if (!source && !quote && !comment && !translation) return null;
	return {
		n,
		kind: "text",
		source: source || undefined,
		quote,
		comment,
		translation,
		page: pageFromSource(source),
	};
}

function isAuxiliaryLine(line: string): boolean {
	return (
		line.startsWith("Auxiliary ") ||
		line.startsWith("No additional surrounding text")
	);
}

function translationFrom(tail: string): string | undefined {
	const lines = tail.split("\n");
	const index = lines.findIndex((line) =>
		line.startsWith("Translation of the quoted sentences:"),
	);
	if (index < 0) return undefined;
	const inline = lines[index]
		.slice("Translation of the quoted sentences:".length)
		.trim();
	if (inline && !inline.startsWith(">")) return cleanComment(inline);
	const quoted: string[] = [];
	for (let i = index + 1; i < lines.length; i++) {
		if (lines[i].startsWith("> ") || lines[i] === ">") {
			quoted.push(lines[i] === ">" ? "" : lines[i].slice(2));
			continue;
		}
		if (lines[i].trim() === "") continue;
		break;
	}
	return cleanComment(quoted.join("\n"));
}

function parseHostAnnotationBlocks(
	text: string,
	byN: Map<number, AnnotationSnapshot>,
) {
	const markerAt = text.lastIndexOf(USER_REQUEST_MARKER);
	if (markerAt < 0) return;
	const region = text.slice(0, markerAt);
	if (!region.includes("Quoted text:")) return;
	const matches = [...region.matchAll(HOST_HEADING_RE)];
	for (let i = 0; i < matches.length; i++) {
		const n = Number(matches[i][1]);
		if (!Number.isInteger(n) || n < 1 || byN.has(n)) continue;
		const start = (matches[i].index ?? 0) + matches[i][0].length;
		const end =
			i + 1 < matches.length
				? (matches[i + 1].index ?? region.length)
				: region.length;
		const snapshot = parseHostBody(n, region.slice(start, end).trim());
		if (snapshot) byN.set(n, snapshot);
	}
}

function parseHostBody(n: number, body: string): AnnotationSnapshot | null {
	if (
		!body.includes("Quoted text:") &&
		!body.includes("User comment on this quote only:")
	) {
		return null;
	}
	const lines = body.split("\n");
	const title = hostField(lines, "Title:");
	const file = hostField(lines, "File:");
	const paper = hostField(lines, "Paper path:");
	const source =
		[title, file || paper].filter(Boolean).join(" — ") || undefined;
	const pageField = hostField(lines, "Page:");
	const page =
		pageField && /^\d+$/.test(pageField) && Number(pageField) >= 1
			? Number(pageField)
			: undefined;
	const quote = quoteFromHost(lines);
	const comment = cleanComment(
		blockAfter(lines, "User comment on this quote only:"),
	);
	const translation = translationFrom(lines.join("\n"));
	if (!quote && !comment && !translation) return null;
	return { n, kind: "text", source, page, quote, comment, translation };
}

function hostField(lines: string[], label: string): string | undefined {
	const line = lines.find((item) => item.startsWith(label));
	const value = line?.slice(label.length).trim();
	return value || undefined;
}

function blockAfter(lines: string[], label: string): string | undefined {
	const index = lines.findIndex((line) => line.startsWith(label));
	if (index < 0) return undefined;
	const parts: string[] = [];
	const first = lines[index].slice(label.length).trim();
	if (first) parts.push(first);
	for (let i = index + 1; i < lines.length; i++) {
		if (HOST_FIELDS.some((field) => lines[i].startsWith(field))) break;
		parts.push(lines[i]);
	}
	const text = parts.join("\n").trim();
	return text || undefined;
}

function quoteFromHost(lines: string[]): string | undefined {
	const block = blockAfter(lines, "Quoted text:");
	if (!block) return undefined;
	const quoted: string[] = [];
	for (const line of block.split("\n")) {
		if (line.startsWith("> ") || line === ">") {
			quoted.push(line === ">" ? "" : line.slice(2));
			continue;
		}
		if (quoted.length > 0) break;
	}
	return quoted.join("\n").trim() || undefined;
}
