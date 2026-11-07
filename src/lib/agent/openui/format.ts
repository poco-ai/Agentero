/**
 * Escape one GFM table cell. Streamdown renders the generated table through
 * the same Markdown pipeline as chat answers, so the string must survive both
 * GFM parsing and the chat table actions (copy / download).
 */
export function escapeGfmCell(value: string): string {
	return value
		.replace(/\\/g, "\\\\")
		.replace(/\|/g, "\\|")
		.replace(/\r?\n/g, " ")
		.trim();
}

/**
 * Build a GFM table string for the chat table renderer. Rows are normalized to
 * the header width; extra cells are ignored and missing cells become empty.
 */
export function openUiTableToGfm(
	columns: readonly string[],
	rows: readonly (readonly string[])[],
): string {
	const headers = columns.map((column) => escapeGfmCell(column));
	if (headers.length === 0) return "";
	const lines = [
		`| ${headers.join(" | ")} |`,
		`| ${headers.map(() => "---").join(" | ")} |`,
	];
	for (const row of rows) {
		const cells = headers.map((_, index) => escapeGfmCell(row[index] ?? ""));
		lines.push(`| ${cells.join(" | ")} |`);
	}
	return lines.join("\n");
}
