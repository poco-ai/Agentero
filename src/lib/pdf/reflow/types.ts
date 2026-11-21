/** Coordinates throughout the IR are page points, top-left origin. */
export type Box = { x: number; y: number; w: number; h: number };
export type CharacterStyle = {
	font: string;
	size: number;
	bold: boolean;
	italic: boolean;
	color: { r: number; g: number; b: number };
};
export type CharacterDisposition =
	| "translated"
	| "formula"
	| "table"
	| "excluded"
	| "rotated"
	| "unresolved"
	| "nonpainting"
	| "clipped";
export type CharacterCoverage = {
	index: number;
	text: string;
	disposition: CharacterDisposition;
	paragraphId?: string;
};
export type Character = {
	clipBoxes?: number[][];
	renderMode?: number;
	textAngle?: number;
	textMatrix?: number[];
	textObjectId?: number;
	index: number;
	text: string;
	box: Box;
	visualBox: Box;
	style: CharacterStyle;
};
export type Formula = {
	id: string;
	text: string;
	box: Box;
	characterIndexes: number[];
	baselineOffset: number;
};
export type Paragraph = {
	id: string;
	pageIndex: number;
	box: Box;
	characters: Character[];
	formulas: Formula[];
	styles: Record<string, CharacterStyle>;
	source: string;
	protectedText: string;
	style: CharacterStyle;
	firstLineIndent: number;
	heading: boolean;
	/** Table cells cannot borrow neighboring cell space. */
	fixedBox?: boolean;
	/** Available placement space, distinct from the source text removal bounds. */
	layoutBox?: Box;
	origin?: "detected" | "table" | "fallback";
};
export type ReflowStructure = Pick<Paragraph, "formulas" | "styles">;
export type ReflowPage = {
	index: number;
	width: number;
	height: number;
	paragraphs: Paragraph[];
	obstacles: Box[];
	coverage?: CharacterCoverage[];
};
/** Bump when persisted character IR shape or extraction semantics change. */
export const REFLOW_IR_SCHEMA_VERSION = 2;
export type ReflowDocument = {
	version: typeof REFLOW_IR_SCHEMA_VERSION;
	pages: ReflowPage[];
};
export type FontKey =
	| "regular"
	| "bold"
	| "italic"
	| "boldItalic"
	| "cjk"
	| "cjkBold";
export type PlacedUnit = {
	text: string;
	/** Offset in the protected translation before line wrapping drops spaces. */
	translatedOffset: number;
	x: number;
	y: number;
	width: number;
	height: number;
	font: FontKey;
	fontSize: number;
	formula?: Formula;
	color: CharacterStyle["color"];
};
export type ParagraphLayout = {
	id: string;
	pageIndex: number;
	sourceBox: Box;
	box: Box;
	scale: number;
	units: PlacedUnit[];
	fits: boolean;
};
export type PageLayout = {
	index: number;
	width: number;
	height: number;
	paragraphs: ParagraphLayout[];
};
export const formulaToken = (id: string): string => `⟪F${id}⟫`;
export function unionBoxes(boxes: readonly Box[]): Box {
	if (!boxes.length) return { x: 0, y: 0, w: 0, h: 0 };
	const x = Math.min(...boxes.map((b) => b.x)),
		y = Math.min(...boxes.map((b) => b.y));
	return {
		x,
		y,
		w: Math.max(...boxes.map((b) => b.x + b.w)) - x,
		h: Math.max(...boxes.map((b) => b.y + b.h)) - y,
	};
}
export function intersects(a: Box, b: Box): boolean {
	return (
		a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
	);
}

/** Formula and style tags are a structural contract, not ordinary prose. */
export function validReflowTranslation(
	p: ReflowStructure,
	text: string,
): boolean {
	const formulas = new Set<string>(),
		opened = new Set<string>(),
		closed = new Set<string>();
	let active: string | undefined;
	for (const match of text.matchAll(/⟪(F|S|\/S)(\d+)⟫/gu)) {
		const kind = match[1],
			id = match[2];
		if (kind === "F") {
			if (!p.formulas.some((f) => f.id === id) || formulas.has(id))
				return false;
			formulas.add(id);
		} else if (kind === "S") {
			if (active || !p.styles[id] || opened.has(id)) return false;
			active = id;
			opened.add(id);
		} else {
			if (active !== id || closed.has(id)) return false;
			active = undefined;
			closed.add(id);
		}
	}
	return (
		!active &&
		p.formulas.every((f) => formulas.has(f.id)) &&
		Object.keys(p.styles).every((id) => opened.has(id) && closed.has(id))
	);
}

export function reflowStructureForText(
	p: Paragraph,
	text: string,
): ReflowStructure {
	return {
		formulas: p.formulas.filter((formula) =>
			text.includes(formulaToken(formula.id)),
		),
		styles: Object.fromEntries(
			Object.entries(p.styles).filter(
				([id]) => text.includes(`⟪S${id}⟫`) || text.includes(`⟪/S${id}⟫`),
			),
		),
	};
}

export function reflowDisplayText(p: Paragraph, text: string): string {
	return text
		.replace(
			/⟪F(\d+)⟫/gu,
			(_, id: string) => p.formulas.find((f) => f.id === id)?.text ?? "",
		)
		.replace(/⟪\/?S\d+⟫/gu, "");
}
