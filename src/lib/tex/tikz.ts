/**
 * A TikZ picture limited to positioned nodes and straight edges. Statements
 * this reader does not understand are kept and written back unchanged.
 */

export type TikzShape = "rectangle" | "circle" | "ellipse" | "diamond";

export type TikzNode = {
	id: string;
	x: number;
	y: number;
	label: string;
	shape: TikzShape;
	fill?: string;
};

export type TikzEdge = {
	id: string;
	source: string;
	target: string;
	arrow: boolean;
};

export type TikzPicture = {
	options: string;
	nodes: TikzNode[];
	edges: TikzEdge[];
	rest: string[];
};

const SHAPES = new Set<TikzShape>([
	"rectangle",
	"circle",
	"ellipse",
	"diamond",
]);

function statements(body: string): string[] {
	const parts: string[] = [];
	let start = 0;
	let depth = 0;
	for (let index = 0; index < body.length; index += 1) {
		const character = body[index];
		if (character === "\\") {
			index += 1;
			continue;
		}
		if (character === "{") depth += 1;
		else if (character === "}") depth = Math.max(0, depth - 1);
		else if (character === ";" && depth === 0) {
			parts.push(body.slice(start, index + 1));
			start = index + 1;
		}
	}
	const tail = body.slice(start);
	if (tail.trim()) parts.push(tail);
	return parts;
}

function shapeOf(options: string): TikzShape {
	for (const shape of SHAPES) {
		if (new RegExp(`\\b${shape}\\b`).test(options)) return shape;
	}
	return "rectangle";
}

function fillOf(options: string): string | undefined {
	return /(?:^|[,[])\s*fill\s*=\s*([A-Za-z]+(?:\s*!\s*\d{1,3})?)/
		.exec(options)?.[1]
		?.replace(/\s+/g, "");
}

function arrowOf(options: string): boolean {
	return /->|>=stealth|latex/.test(options);
}

function cleanLabel(label: string): string {
	return label.replace(/\s+/g, " ").trim();
}

/** Parse one picture, including its `\begin` / `\end` lines. */
export function parseTikz(source: string): TikzPicture | null {
	const begin = /\\begin\{tikzpicture\}(\[[^\]]*\])?/.exec(source);
	const end = source.lastIndexOf("\\end{tikzpicture}");
	if (!begin || end < begin.index) return null;
	const body = source.slice(begin.index + begin[0].length, end);
	const picture: TikzPicture = {
		options: begin[1] ?? "",
		nodes: [],
		edges: [],
		rest: [],
	};
	let generated = 0;
	for (const statement of statements(body)) {
		const node =
			/^\s*\\node\s*(\[[^\]]*\])?\s*(?:\(([^)]+)\))?\s*(?:at\s*\(\s*([+-]?\d*\.?\d+)\s*,\s*([+-]?\d*\.?\d+)\s*\))?\s*\{([\s\S]*)\}\s*;\s*$/.exec(
				statement,
			);
		if (node) {
			generated += 1;
			const options = node[1] ?? "";
			picture.nodes.push({
				id: (node[2] ?? `n${generated}`).trim(),
				x: Number(node[3] ?? 0),
				y: Number(node[4] ?? 0),
				label: cleanLabel(node[5] ?? ""),
				shape: shapeOf(options),
				fill: fillOf(options),
			});
			continue;
		}
		const edge =
			/^\s*\\(?:draw|path)\s*(\[[^\]]*\])?\s*\(([^)]+)\)\s*(?:--|edge)\s*\(([^)]+)\)\s*;\s*$/.exec(
				statement,
			);
		if (edge) {
			picture.edges.push({
				id: `e${picture.edges.length + 1}`,
				source: (edge[2] ?? "").trim(),
				target: (edge[3] ?? "").trim(),
				arrow: arrowOf(edge[1] ?? ""),
			});
			continue;
		}
		if (statement.trim()) picture.rest.push(statement.trim());
	}
	return picture;
}

function nodeOptions(node: TikzNode): string {
	const parts = [
		node.shape === "rectangle" ? "" : node.shape,
		node.fill ? `fill=${node.fill}` : "",
	].filter(Boolean);
	return parts.length ? `[${parts.join(", ")}]` : "";
}

/** Write the picture back, preserving statements that were not edited. */
export function serializeTikz(picture: TikzPicture): string {
	const nodes = picture.nodes.map(
		(node) =>
			`\\node${nodeOptions(node)} (${node.id}) at (${node.x}, ${node.y}) {${node.label}};`,
	);
	const edges = picture.edges
		.filter((edge) => edge.source && edge.target)
		.map(
			(edge) =>
				`\\draw${edge.arrow ? "[->]" : ""} (${edge.source}) -- (${edge.target});`,
		);
	const lines = [...nodes, ...edges, ...picture.rest];
	return `\\begin{tikzpicture}${picture.options}\n${lines.join("\n")}\n\\end{tikzpicture}`;
}

/** The picture that contains `offset`, if the cursor sits inside one. */
export function tikzPictureAround(
	source: string,
	offset: number,
): { from: number; to: number } | null {
	const begin = "\\begin{tikzpicture}";
	const endMark = "\\end{tikzpicture}";
	const from = source.lastIndexOf(begin, Math.max(0, offset));
	if (from < 0) return null;
	const end = source.indexOf(endMark, from);
	if (end < 0) return null;
	const to = end + endMark.length;
	if (offset < from || offset > to) return null;
	return { from, to };
}

export function emptyTikzPicture(): TikzPicture {
	return {
		options: "",
		nodes: [
			{
				id: "a",
				x: 0,
				y: 0,
				label: "",
				shape: "rectangle",
			},
		],
		edges: [],
		rest: [],
	};
}
