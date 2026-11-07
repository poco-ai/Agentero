import { z } from "zod";
import { safeTableReference } from "@/lib/research-table/markdown";

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
	"link",
] as const;
export type CellValue = string | number | boolean | null;
const REGISTRY_ID = /^[A-Za-z][A-Za-z0-9]*-\d{4,}$/;
const REGISTRY_PARTS = /^([A-Za-z][A-Za-z0-9]*)-(\d{4,})$/;
const timestampSchema = z.iso.datetime();
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
		target: z.string().optional(),
		width: z.number().int().min(80).max(480).optional(),
	})
	.strict();
const rowSchema = z
	.object({
		id: z.string().min(1),
		values: z.record(
			z.string(),
			z.union([z.string(), z.number().finite(), z.boolean(), z.null()]),
		),
		registryId: z.string().optional(),
		createdAt: timestampSchema.optional(),
		updatedAt: timestampSchema.optional(),
		archivedAt: timestampSchema.optional(),
		actor: z.enum(["human", "agent"]).optional(),
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
		idPrefix: z
			.string()
			.min(1)
			.max(12)
			.regex(/^[A-Za-z][A-Za-z0-9]*$/)
			.optional(),
		nextSequence: z.number().int().positive().optional(),
		schemaPath: z.string().optional(),
		appliedKeys: z.array(z.string().min(1).max(80)).max(50).optional(),
		fields: z.array(fieldSchema).min(1).max(MAX_TABLE_COLUMNS),
		rows: z.array(rowSchema).max(MAX_TABLE_ROWS),
	})
	.strict();
export type ResearchTable = z.infer<typeof tableSchema>;
export type TableField = z.infer<typeof fieldSchema>;
export type TableRow = z.infer<typeof rowSchema>;
export type SchemaProblem = {
	id: string;
	issue: "missing" | "name" | "type" | "unit" | "options";
};

export function isResearchTablePath(path: string): boolean {
	return path.toLowerCase().endsWith(TABLE_SUFFIX);
}

/** Display name for a `*.table.json` filename. The cut follows the suffix length. */
export function researchTableStem(filename: string): string {
	if (!isResearchTablePath(filename)) return filename;
	return filename.slice(0, -TABLE_SUFFIX.length);
}

/** Vault-relative schema path. Rejects this table when the caller knows its path. */
export function acceptsSchemaPath(
	path: string,
	ownRelativePath?: string,
): boolean {
	if (!safeTableReference(path)) return false;
	return ownRelativePath === undefined || path !== ownRelativePath;
}

export function createResearchTable(name: string): ResearchTable {
	return {
		format: "agentero-table",
		version: 1,
		id: crypto.randomUUID(),
		name,
		kind: "result",
		revision: 0,
		idPrefix: "ID",
		nextSequence: 1,
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
		case "link":
			return typeof value === "string" && REGISTRY_ID.test(value);
	}
}
function assertFieldShape(field: TableField) {
	if (
		new Set(field.options).size !== field.options.length ||
		(field.type === "select" && !field.options.length)
	)
		throw new Error("invalid select options");
	if (field.type === "link") {
		if (field.options.length > 0 || field.unit.trim() !== "")
			throw new Error("invalid link field");
		if (
			field.target !== undefined &&
			field.target !== "" &&
			!safeTableReference(field.target)
		)
			throw new Error("invalid table path");
		return;
	}
	if (field.target !== undefined) throw new Error("invalid link field");
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
	if (table.schemaPath !== undefined && !safeTableReference(table.schemaPath))
		throw new Error("invalid table path");
	for (const field of table.fields) assertFieldShape(field);
	const registryIds: string[] = [];
	for (const row of table.rows) {
		if (row.registryId === undefined) continue;
		if (!REGISTRY_ID.test(row.registryId))
			throw new Error("invalid registry id");
		registryIds.push(row.registryId);
	}
	if (new Set(registryIds).size !== registryIds.length)
		throw new Error("duplicate registry id");
	for (const row of table.rows)
		for (const [id, value] of Object.entries(row.values)) {
			const field = fields.get(id);
			if (!field || !validCell(value, field))
				throw new Error(`invalid cell: ${row.id}/${id}`);
		}
	return table;
}
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
export function cellFromText(text: string, field: TableField): CellValue {
	if (text === "") return null;
	let value: CellValue = text;
	if (field.type === "number") {
		const trimmed = text.trim();
		// Number("0x10") is 16. Only plain decimals are measurements.
		value = trimmed
			? DECIMAL.test(trimmed)
				? Number(trimmed)
				: Number.NaN
			: null;
	}
	if (field.type === "boolean") {
		if (/^(true|1)$/i.test(text.trim())) value = true;
		else if (/^(false|0)$/i.test(text.trim())) value = false;
	}
	if (field.type === "link") {
		const trimmed = text.trim();
		value = trimmed ? trimmed : null;
	}
	if (!validCell(value, field)) throw new Error(field.name);
	return value;
}
function usedSequence(prefix: string, registryId: string): number | null {
	const match = REGISTRY_PARTS.exec(registryId);
	if (!match || match[1] !== prefix) return null;
	const value = Number(match[2]);
	return Number.isSafeInteger(value) ? value : null;
}
function issueStart(table: ResearchTable, prefix: string): number {
	let next = table.nextSequence ?? 1;
	for (const row of table.rows) {
		if (!row.registryId) continue;
		const used = usedSequence(prefix, row.registryId);
		if (used !== null && used >= next) next = used + 1;
	}
	return next;
}

const MIN_COLUMN_WIDTH = 80;
const MAX_COLUMN_WIDTH = 480;

/** Grid width for a field. A unit uses 220; every other field uses 200. */
export function displayedColumnWidth(
	field: Pick<TableField, "unit" | "width">,
): number {
	return field.width ?? (field.unit ? 220 : 200);
}

/**
 * Persist a column resize. The default width is omitted so an untouched file
 * does not grow a `width` key.
 */
export function resizeColumn(
	table: ResearchTable,
	index: number,
	width: number,
): ResearchTable {
	const field = table.fields[index];
	if (!field || !Number.isFinite(width)) return table;
	const nextWidth = Math.min(
		MAX_COLUMN_WIDTH,
		Math.max(MIN_COLUMN_WIDTH, Math.round(width)),
	);
	const fallback = field.unit ? 220 : 200;
	if (nextWidth === fallback) {
		if (field.width === undefined) return table;
		return {
			...table,
			fields: table.fields.map((item, itemIndex) => {
				if (itemIndex !== index) return item;
				const next = { ...item };
				delete next.width;
				return next;
			}),
		};
	}
	if (field.width === nextWidth) return table;
	return {
		...table,
		fields: table.fields.map((item, itemIndex) =>
			itemIndex === index ? { ...item, width: nextWidth } : item,
		),
	};
}

export function appendRows(table: ResearchTable, count: number): ResearchTable {
	if (
		!Number.isInteger(count) ||
		count < 1 ||
		table.rows.length + count > MAX_TABLE_ROWS
	)
		throw new Error("row limit");
	const idPrefix = table.idPrefix ?? "ID";
	let sequence = issueStart(table, idPrefix);
	const now = new Date().toISOString();
	const added: TableRow[] = [];
	for (let index = 0; index < count; index++) {
		added.push({
			id: crypto.randomUUID(),
			values: {},
			registryId: `${idPrefix}-${String(sequence).padStart(4, "0")}`,
			createdAt: now,
			updatedAt: now,
			actor: "human",
		});
		sequence += 1;
	}
	return {
		...table,
		idPrefix,
		nextSequence: sequence,
		rows: [...table.rows, ...added],
	};
}

/** Append copies of stored rows. New ids and registry numbers; archive state stays behind. */
export function duplicateRows(
	table: ResearchTable,
	rowIndexes: readonly number[],
): ResearchTable {
	const targets = rowIndexSet(table, rowIndexes);
	if (!targets.size) return table;
	if (table.rows.length + targets.size > MAX_TABLE_ROWS)
		throw new Error("row limit");
	const idPrefix = table.idPrefix ?? "ID";
	let sequence = issueStart(table, idPrefix);
	const now = new Date().toISOString();
	const added: TableRow[] = [];
	const seen = new Set<number>();
	for (const index of rowIndexes) {
		if (seen.has(index)) continue;
		seen.add(index);
		const source = table.rows[index];
		if (!source) throw new Error("cell bounds");
		added.push({
			id: crypto.randomUUID(),
			values: { ...source.values },
			registryId: `${idPrefix}-${String(sequence).padStart(4, "0")}`,
			createdAt: now,
			updatedAt: now,
			actor: "human",
		});
		sequence += 1;
	}
	return {
		...table,
		idPrefix,
		nextSequence: sequence,
		rows: [...table.rows, ...added],
	};
}

function assignCell(
	rows: TableRow[],
	index: number,
	fieldId: string,
	value: CellValue,
	now: string,
): boolean {
	const record = rows[index];
	if (!record) throw new Error("cell bounds");
	if (Object.hasOwn(record.values, fieldId) && record.values[fieldId] === value)
		return false;
	rows[index] = {
		...record,
		values: { ...record.values, [fieldId]: value },
		updatedAt: now,
		actor: "human",
	};
	return true;
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
	const now = new Date().toISOString();
	let changed = next !== table;
	parsed.forEach((line, y) => {
		line.forEach((value, x) => {
			if (assignCell(rows, row + y, table.fields[col + x].id, value, now))
				changed = true;
		});
	});
	return changed ? { ...next, rows } : next;
}
/** Last `limit` items. Callers that mean the latest experiments pass active rows. */
export function previewRows<T>(rows: readonly T[], limit = 20): T[] {
	const count = Math.max(0, Math.trunc(limit));
	if (count === 0) return [];
	return rows.slice(-count);
}

export function fieldChangeNeedsMigration(
	table: ResearchTable,
	field: TableField,
): boolean {
	const previous = table.fields.find((item) => item.id === field.id);
	if (!previous) return false;
	const hasValues = table.rows.some(
		(row) =>
			row.values[previous.id] !== undefined && row.values[previous.id] !== null,
	);
	if (!hasValues) return false;
	const nextUnit = field.type === "number" ? field.unit.trim() : "";
	const previousUnit = previous.type === "number" ? previous.unit.trim() : "";
	return previous.type !== field.type || previousUnit !== nextUnit;
}

export function optionUsage(
	table: ResearchTable,
	fieldId: string,
	option: string,
): number {
	return table.rows.reduce(
		(count, row) => count + (row.values[fieldId] === option ? 1 : 0),
		0,
	);
}

function storedField(field: TableField): TableField {
	const next: TableField = {
		id: field.id,
		name: field.name.trim(),
		type: field.type,
		unit: field.type === "number" ? field.unit.trim() : "",
		options:
			field.type === "select"
				? field.options.map((option) => option.trim())
				: [],
	};
	if (field.width !== undefined) next.width = field.width;
	if (field.type !== "link") return next;
	const target = field.target?.trim() ?? "";
	if (target && !safeTableReference(target))
		throw new Error("invalid table path");
	if (target) next.target = target;
	return next;
}

export function replaceField(
	table: ResearchTable,
	field: TableField,
	renames: Readonly<Record<string, string>> = {},
): ResearchTable {
	const previous = table.fields.find((item) => item.id === field.id);
	if (fieldChangeNeedsMigration(table, field))
		throw new Error(
			"existing values require an explicit type or unit migration",
		);
	field = storedField(field);
	let rows = table.rows;
	if (previous?.type === "select" && field.type === "select") {
		const allowed = new Set(previous.options);
		const mapped = new Map<string, string>();
		for (const [from, to] of Object.entries(renames)) {
			const next = to.trim();
			if (!allowed.has(from) || !next || next === from) continue;
			mapped.set(from, next);
		}
		if (mapped.size)
			rows = rows.map((row) => {
				const value = row.values[field.id];
				if (typeof value !== "string" || !mapped.has(value)) return row;
				return {
					...row,
					values: { ...row.values, [field.id]: mapped.get(value) ?? value },
				};
			});
		const options = new Set(field.options);
		let used = 0;
		for (const row of rows) {
			const value = row.values[field.id];
			if (typeof value === "string" && value !== "" && !options.has(value))
				used += 1;
		}
		if (used) throw new Error(`option in use: ${used}`);
	}
	const fields = table.fields.some((item) => item.id === field.id)
		? table.fields.map((item) => (item.id === field.id ? field : item))
		: [...table.fields, field];
	// Reuse the same validation for UI changes and Agent-authored files.
	return parseResearchTable(JSON.stringify({ ...table, fields, rows }));
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
	const now = new Date().toISOString();
	let changed = next !== table;
	for (const edit of parsed) {
		if (assignCell(rows, edit.row, table.fields[edit.col].id, edit.value, now))
			changed = true;
	}
	return changed ? { ...next, rows } : next;
}

function rowIndexSet(
	table: ResearchTable,
	rowIndexes: readonly number[],
): Set<number> {
	const targets = new Set<number>();
	for (const index of rowIndexes) {
		if (!Number.isInteger(index) || index < 0 || index >= table.rows.length)
			throw new Error("cell bounds");
		targets.add(index);
	}
	return targets;
}

export function archiveRows(
	table: ResearchTable,
	rowIndexes: readonly number[],
): ResearchTable {
	const targets = rowIndexSet(table, rowIndexes);
	if (!targets.size) return table;
	const now = new Date().toISOString();
	let changed = false;
	const rows = table.rows.map((row, index): TableRow => {
		if (!targets.has(index) || row.archivedAt) return row;
		changed = true;
		const next: TableRow = {
			...row,
			archivedAt: now,
			updatedAt: now,
			actor: "human",
		};
		return next;
	});
	return changed ? { ...table, rows } : table;
}

export function restoreRows(
	table: ResearchTable,
	rowIndexes: readonly number[],
): ResearchTable {
	const targets = rowIndexSet(table, rowIndexes);
	if (!targets.size) return table;
	const now = new Date().toISOString();
	let changed = false;
	const rows = table.rows.map((row, index): TableRow => {
		if (!targets.has(index) || row.archivedAt === undefined) return row;
		changed = true;
		const restored: TableRow = { ...row, updatedAt: now };
		delete restored.archivedAt;
		return restored;
	});
	return changed ? { ...table, rows } : table;
}

export function removeRows(
	table: ResearchTable,
	rowIndexes: readonly number[],
): ResearchTable {
	const targets = rowIndexSet(table, rowIndexes);
	if (!targets.size) return table;
	for (const index of targets)
		if (!table.rows[index]?.archivedAt)
			throw new Error("archive before delete");
	return {
		...table,
		rows: table.rows.filter((_, index) => !targets.has(index)),
	};
}

export function checkSchema(
	instance: ResearchTable,
	schema: ResearchTable,
): { ok: boolean; problems: SchemaProblem[] } {
	const byId = new Map(instance.fields.map((field) => [field.id, field]));
	const problems: SchemaProblem[] = [];
	for (const wanted of schema.fields) {
		const have = byId.get(wanted.id);
		if (!have) {
			problems.push({ id: wanted.id, issue: "missing" });
			continue;
		}
		if (have.name.trim() !== wanted.name.trim())
			problems.push({ id: wanted.id, issue: "name" });
		if (have.type !== wanted.type)
			problems.push({ id: wanted.id, issue: "type" });
		if (have.unit.trim() !== wanted.unit.trim())
			problems.push({ id: wanted.id, issue: "unit" });
		if (
			have.options.length !== wanted.options.length ||
			have.options.some((option, index) => option !== wanted.options[index])
		)
			problems.push({ id: wanted.id, issue: "options" });
	}
	return { ok: problems.length === 0, problems };
}

export function applySchemaFields(
	instance: ResearchTable,
	schema: ResearchTable,
): ResearchTable {
	const have = new Set(instance.fields.map((field) => field.id));
	const added: TableField[] = [];
	for (const field of schema.fields) {
		if (have.has(field.id)) continue;
		const next: TableField = {
			id: field.id,
			name: field.name,
			type: field.type,
			unit: field.type === "number" ? field.unit : "",
			options: field.type === "select" ? [...field.options] : [],
		};
		if (field.type === "link" && field.target) next.target = field.target;
		if (field.width !== undefined) next.width = field.width;
		added.push(next);
	}
	if (!added.length) return instance;
	if (instance.fields.length + added.length > MAX_TABLE_COLUMNS)
		throw new Error("column limit");
	return parseResearchTable(
		JSON.stringify({ ...instance, fields: [...instance.fields, ...added] }),
	);
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
