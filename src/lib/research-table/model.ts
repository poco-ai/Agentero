import { z } from "zod";

export const TABLE_SUFFIX = ".table.json";
export const MAX_TABLE_ROWS = 100_000;
export const MAX_TABLE_COLUMNS = 100;
export const MAX_PASTE_CELLS = 100_000;
export const fieldTypes = [
	"text",
	"number",
	"boolean",
	"date",
	"select",
] as const;
export type CellValue = string | number | boolean | null;
const fieldSchema = z
	.object({
		id: z
			.string()
			.min(1)
			.refine((id) => !["__proto__", "constructor", "prototype"].includes(id)),
		name: z.string().trim().min(1).max(120),
		type: z.enum(fieldTypes),
		unit: z.string().max(40).default(""),
		options: z.array(z.string().min(1)).max(200).default([]),
	})
	.strict();
const rowSchema = z
	.object({
		id: z.string().min(1),
		values: z.record(
			z.string(),
			z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
		),
	})
	.strict();
const tableSchema = z
	.object({
		format: z.literal("agentero-table"),
		version: z.literal(1),
		id: z.string().min(1),
		name: z.string().trim().min(1),
		kind: z.enum(["entity", "result"]),
		revision: z.number().int().nonnegative(),
		fields: z.array(fieldSchema).min(1).max(MAX_TABLE_COLUMNS),
		rows: z.array(rowSchema).max(MAX_TABLE_ROWS),
	})
	.strict();
export type ResearchTable = z.infer<typeof tableSchema>;
export type TableField = z.infer<typeof fieldSchema>;
export type TableRow = z.infer<typeof rowSchema>;

export function isResearchTablePath(path: string): boolean {
	return path.toLowerCase().endsWith(TABLE_SUFFIX);
}
export function createResearchTable(name: string): ResearchTable {
	return {
		format: "agentero-table",
		version: 1,
		id: crypto.randomUUID(),
		name,
		kind: "result",
		revision: 0,
		fields: [
			{
				id: crypto.randomUUID(),
				name: "Name",
				type: "text",
				unit: "",
				options: [],
			},
		],
		rows: [],
	};
}
export function validCell(value: CellValue, field: TableField): boolean {
	if (value === null) return true;
	switch (field.type) {
		case "text":
			return typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "boolean":
			return typeof value === "boolean";
		case "date":
			return (
				typeof value === "string" &&
				/^\d{4}-\d{2}-\d{2}$/.test(value) &&
				!Number.isNaN(Date.parse(value)) &&
				new Date(value).toISOString().slice(0, 10) === value
			);
		case "select":
			return typeof value === "string" && field.options.includes(value);
	}
}
export function parseResearchTable(source: string): ResearchTable {
	const table = tableSchema.parse(JSON.parse(source));
	const fields = new Map(table.fields.map((field) => [field.id, field]));
	if (
		fields.size !== table.fields.length ||
		new Set(table.fields.map((f) => f.name.toLocaleLowerCase())).size !==
			fields.size ||
		new Set(table.rows.map((row) => row.id)).size !== table.rows.length
	)
		throw new Error("duplicate identity or field name");
	for (const field of table.fields) {
		if (
			new Set(field.options).size !== field.options.length ||
			(field.type === "select" && !field.options.length)
		)
			throw new Error("invalid select options");
	}
	for (const row of table.rows)
		for (const [id, value] of Object.entries(row.values)) {
			const field = fields.get(id);
			if (!field || !validCell(value, field))
				throw new Error(`invalid cell: ${row.id}/${id}`);
		}
	return table;
}
export function cellFromText(text: string, field: TableField): CellValue {
	if (text === "") return null;
	let value: CellValue = text;
	if (field.type === "number") value = text.trim() ? Number(text) : null;
	if (field.type === "boolean") {
		if (/^(true|1)$/i.test(text.trim())) value = true;
		else if (/^(false|0)$/i.test(text.trim())) value = false;
	}
	if (!validCell(value, field)) throw new Error(field.name);
	return value;
}
export function appendRows(table: ResearchTable, count: number): ResearchTable {
	if (
		!Number.isInteger(count) ||
		count < 1 ||
		table.rows.length + count > MAX_TABLE_ROWS
	)
		throw new Error("row limit");
	return {
		...table,
		rows: [
			...table.rows,
			...Array.from({ length: count }, () => ({
				id: crypto.randomUUID(),
				values: {},
			})),
		],
	};
}
/** Parse everything before creating a new snapshot: an invalid paste changes no cells. */
export function pasteCells(
	table: ResearchTable,
	col: number,
	row: number,
	matrix: readonly (readonly string[])[],
): ResearchTable {
	if (
		!Number.isInteger(col) ||
		!Number.isInteger(row) ||
		col < 0 ||
		row < 0 ||
		!matrix.length ||
		matrix.reduce((n, line) => n + line.length, 0) > MAX_PASTE_CELLS ||
		row + matrix.length > MAX_TABLE_ROWS
	)
		throw new Error("paste limit");
	const parsed = matrix.map((line) =>
		line.map((text, x) => {
			const field = table.fields[col + x];
			if (!field) throw new Error("column limit");
			return cellFromText(text, field);
		}),
	);
	const next =
		row + matrix.length > table.rows.length
			? appendRows(table, row + matrix.length - table.rows.length)
			: table;
	const rows = next.rows.slice();
	parsed.forEach((line, y) => {
		const record = rows[row + y];
		const values = { ...record.values };
		line.forEach((value, x) => {
			values[table.fields[col + x].id] = value;
		});
		rows[row + y] = { ...record, values };
	});
	return { ...next, rows };
}
export function replaceField(
	table: ResearchTable,
	field: TableField,
): ResearchTable {
	const previous = table.fields.find((f) => f.id === field.id);
	if (
		previous &&
		(previous.unit !== field.unit || previous.type !== field.type) &&
		table.rows.some(
			(row) =>
				row.values[field.id] !== undefined && row.values[field.id] !== null,
		)
	)
		throw new Error(
			"existing values require an explicit type or unit migration",
		);
	field = {
		...field,
		name: field.name.trim(),
		unit: field.type === "number" ? field.unit.trim() : "",
		options: field.type === "select" ? field.options : [],
	};
	const fields = table.fields.some((f) => f.id === field.id)
		? table.fields.map((f) => (f.id === field.id ? field : f))
		: [...table.fields, field];
	// Reuse the same validation for UI changes and Agent-authored files.
	return parseResearchTable(JSON.stringify({ ...table, fields }));
}

export function editCells(
	table: ResearchTable,
	edits: readonly { col: number; row: number; text: string }[],
): ResearchTable {
	if (!edits.length) return table;
	if (edits.length > MAX_PASTE_CELLS) throw new Error("paste limit");
	const parsed = edits.map((edit) => {
		if (
			!Number.isInteger(edit.col) ||
			!Number.isInteger(edit.row) ||
			edit.col < 0 ||
			edit.row < 0 ||
			edit.row >= MAX_TABLE_ROWS ||
			!table.fields[edit.col]
		)
			throw new Error("cell bounds");
		return { ...edit, value: cellFromText(edit.text, table.fields[edit.col]) };
	});
	const required = parsed.reduce(
		(n, edit) => Math.max(n, edit.row + 1),
		table.rows.length,
	);
	const next =
		required > table.rows.length
			? appendRows(table, required - table.rows.length)
			: table;
	const rows = next.rows.slice();
	const copied = new Set<number>();
	for (const edit of parsed) {
		if (!copied.has(edit.row)) {
			rows[edit.row] = {
				...rows[edit.row],
				values: { ...rows[edit.row].values },
			};
			copied.add(edit.row);
		}
		rows[edit.row].values[table.fields[edit.col].id] = edit.value;
	}
	return { ...next, rows };
}

export function removeField(table: ResearchTable, id: string): ResearchTable {
	if (table.fields.length === 1)
		throw new Error("a table requires at least one field");
	return {
		...table,
		fields: table.fields.filter((field) => field.id !== id),
		rows: table.rows.map((row) => {
			const values = { ...row.values };
			delete values[id];
			return { ...row, values };
		}),
	};
}
