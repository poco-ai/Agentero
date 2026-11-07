import type { MdRules } from "@platejs/markdown";
export const RESEARCH_TABLE_KEY = "research_table";
type Node = {
	type: string;
	name?: string;
	attributes?: Record<string, string>;
	children?: Node[];
	tablePath?: string;
	tableId?: string;
};

/** Clipboard and new-note form. `id` is omitted when empty so path-only notes stay path-only. */
export function researchTableDirective(path: string, id?: string): string {
	const attributes: string[] = [];
	if (id) attributes.push(`id=${JSON.stringify(id)}`);
	if (path || !id) attributes.push(`path=${JSON.stringify(path)}`);
	return `::research-table{${attributes.join(" ")}}`;
}
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
						tableId: child.attributes?.id ?? "",
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
			tableId: (node as unknown as Node).tableId ?? "",
			children: [{ text: "" }],
		}),
		serialize: (node) => {
			const path = String(node.tablePath ?? "");
			const id = String(node.tableId ?? "");
			const attributes: Record<string, string> = {};
			if (id) attributes.id = id;
			if (path || !id) attributes.path = path;
			return {
				type: "leafDirective",
				name: "research-table",
				attributes,
				children: [],
			};
		},
	},
} satisfies MdRules;
