import i18n from "@/i18n";
import { researchTableDirective } from "@/lib/research-table/markdown";
import { TABLE_SUFFIX } from "@/lib/research-table/model";

/** Stem shared by the note and its sibling table. */
export function experimentFileStem(name: string): string {
	const trimmed = name.trim();
	const lower = trimmed.toLowerCase();
	if (lower.endsWith(TABLE_SUFFIX)) {
		return trimmed.slice(0, -TABLE_SUFFIX.length).trim();
	}
	if (lower.endsWith(".md")) return trimmed.slice(0, -3).trim();
	return trimmed;
}

/** New experiment note in the active language. Properties stay empty. */
export function experimentNoteMarkdown(
	tableId: string,
	tablePath: string,
): string {
	const purpose = i18n.t("editor:experiment.purpose");
	const steps = i18n.t("editor:experiment.steps");
	const results = i18n.t("editor:experiment.results");
	const embed = researchTableDirective(tablePath, tableId);
	return `## ${purpose}\n\n## ${steps}\n\n## ${results}\n\n${embed}\n`;
}
