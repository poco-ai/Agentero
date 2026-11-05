import type { MdRules } from "@platejs/markdown";
export const RESEARCH_TABLE_KEY = "research_table";
type Node = {
	type: string;
	name?: string;
	attributes?: Record<string, string>;
	children?: Node[];
	tablePath?: string;
};
export function safeTableReference(path: string): boolean {
	return (
		path.length > 0 &&
		path.toLowerCase().endsWith(".table.json") &&
		!/[\\:#]/.test(path) &&
		![...path].some((char) => char.charCodeAt(0) < 32) &&
		path.split("/").every((part) => part.length > 0 && !part.startsWith("."))
	);
}
export function remarkResearchTable() {
	return (tree: Node) => {
		const visit = (node: Node) => {
			if (!node.children) return;
			node.children = node.children.map((child) => {
				if (child.type === "leafDirective" && child.name === "research-table")
					return {
						type: RESEARCH_TABLE_KEY,
						tablePath: child.attributes?.path ?? "",
					};
				visit(child);
				return child;
			});
		};
		visit(tree);
	};
}
export const researchTableRules = {
	[RESEARCH_TABLE_KEY]: {
		deserialize: (node) => ({
			type: RESEARCH_TABLE_KEY,
			tablePath: (node as unknown as Node).tablePath ?? "",
			children: [{ text: "" }],
		}),
		serialize: (node) => ({
			type: "leafDirective",
			name: "research-table",
			attributes: { path: String(node.tablePath ?? "") },
			children: [],
		}),
	},
} satisfies MdRules;
