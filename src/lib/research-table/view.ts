import {
	type CellValue,
	editCells,
	MAX_PASTE_CELLS,
	MAX_TABLE_ROWS,
	type ResearchTable,
} from "@/lib/research-table/model";

export type TableSort = {
	fieldId: string;
	direction: "asc" | "desc";
};

export type TableView = {
	query: string;
	sort: TableSort | null;
	showArchived?: boolean;
};

/** Header click cycles ascending, descending, then back to stored order. */
export function cycleSort(
	current: TableSort | null,
	fieldId: string,
): TableSort | null {
	if (current?.fieldId !== fieldId) return { fieldId, direction: "asc" };
	if (current.direction === "asc") return { fieldId, direction: "desc" };
	return null;
}

export function rowLabel(table: ResearchTable, index: number): string {
	const row = table.rows[index];
	if (!row) return "";
	for (const field of table.fields) {
		const value = row.values[field.id];
		if (value === null || value === undefined || value === "") continue;
		return String(value);
	}
	return "";
}

/** Registry ids in this table, with the row's first text value when it has one. */
export function registryChoices(
	table: ResearchTable,
): { id: string; text: string }[] {
	const choices: { id: string; text: string }[] = [];
	for (let index = 0; index < table.rows.length; index++) {
		const row = table.rows[index];
		if (!row?.registryId || row.archivedAt) continue;
		let text = "";
		for (const field of table.fields) {
			if (field.type !== "text") continue;
			const value = row.values[field.id];
			if (typeof value === "string" && value.trim()) {
				text = value.trim();
				break;
			}
		}
		choices.push({ id: row.registryId, text });
	}
	return choices;
}

/**
 * View row → stored row. Indexes past the visible list append after the
 * stored rows, which is the trailing entry row.
 */
export function sourceRowIndex(
	viewRow: number,
	visible: readonly number[],
	storedLength: number,
): number {
	if (viewRow < visible.length) return visible[viewRow];
	return storedLength + (viewRow - visible.length);
}

/** Stored indexes in view order. Archived rows stay hidden unless `showArchived`. */
export function visibleRowIndexes(
	table: ResearchTable,
	view: TableView,
): number[] {
	const query = view.query.trim().toLocaleLowerCase();
	let indexes = table.rows.map((_, index) => index);
	if (!view.showArchived)
		indexes = indexes.filter((index) => !table.rows[index]?.archivedAt);
	if (query)
		indexes = indexes.filter((index) =>
			table.fields.some((field) => {
				const value = table.rows[index]?.values[field.id];
				if (value === null || value === undefined) return false;
				return String(value).toLocaleLowerCase().includes(query);
			}),
		);
	const field = view.sort
		? table.fields.find((item) => item.id === view.sort?.fieldId)
		: undefined;
	if (!field || !view.sort) return indexes;
	const direction = view.sort.direction === "asc" ? 1 : -1;
	return indexes
		.map((index) => ({
			index,
			value: table.rows[index]?.values[field.id] ?? null,
		}))
		.sort((a, b) => compareViewValues(a, b, direction))
		.map((item) => item.index);
}

function compareViewValues(
	a: { index: number; value: CellValue },
	b: { index: number; value: CellValue },
	direction: number,
): number {
	if (a.value === null && b.value === null) return a.index - b.index;
	if (a.value === null) return 1;
	if (b.value === null) return -1;
	const order = comparePresent(a.value, b.value) * direction;
	return order || a.index - b.index;
}

function comparePresent(
	a: Exclude<CellValue, null>,
	b: Exclude<CellValue, null>,
) {
	if (typeof a === "number" && typeof b === "number") return a - b;
	if (typeof a === "boolean" && typeof b === "boolean")
		return Number(a) - Number(b);
	return String(a).localeCompare(String(b), undefined, {
		numeric: true,
		sensitivity: "base",
	});
}

export function applyViewEdits(
	table: ResearchTable,
	edits: readonly { col: number; viewRow: number; text: string }[],
	visible: readonly number[],
): ResearchTable {
	return editCells(
		table,
		edits.map((edit) => ({
			col: edit.col,
			row: sourceRowIndex(edit.viewRow, visible, table.rows.length),
			text: edit.text,
		})),
	);
}

/** Paste onto the view. Rows past the visible list append; stored order stays put. */
export function applyViewPaste(
	table: ResearchTable,
	col: number,
	viewRow: number,
	matrix: readonly (readonly string[])[],
	visible: readonly number[],
): ResearchTable {
	if (
		!Number.isInteger(col) ||
		!Number.isInteger(viewRow) ||
		col < 0 ||
		viewRow < 0 ||
		!matrix.length ||
		matrix.reduce((count, line) => count + line.length, 0) > MAX_PASTE_CELLS
	)
		throw new Error("paste limit");
	const edits: { col: number; viewRow: number; text: string }[] = [];
	matrix.forEach((line, y) => {
		const row = sourceRowIndex(viewRow + y, visible, table.rows.length);
		if (row >= MAX_TABLE_ROWS) throw new Error("paste limit");
		line.forEach((text, x) => {
			if (!table.fields[col + x]) throw new Error("column limit");
			edits.push({ col: col + x, viewRow: viewRow + y, text });
		});
	});
	return applyViewEdits(table, edits, visible);
}

function csvCell(value: unknown): string {
	return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

/** Active rows only. `registryId` is the first column; archived rows are left out. */
export function researchTableCsv(table: ResearchTable): string {
	const lines = [
		[
			csvCell("registryId"),
			...table.fields.map((field) =>
				csvCell(field.unit ? `${field.name} (${field.unit})` : field.name),
			),
		].join(","),
	];
	for (const row of table.rows) {
		if (row.archivedAt !== undefined) continue;
		lines.push(
			[
				csvCell(row.registryId),
				...table.fields.map((field) => csvCell(row.values[field.id])),
			].join(","),
		);
	}
	return lines.join("\r\n");
}
