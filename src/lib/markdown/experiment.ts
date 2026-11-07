import i18n from "@/i18n";
import { researchTableDirective } from "@/lib/research-table/markdown";
import { TABLE_SUFFIX } from "@/lib/research-table/model";

export const EXPERIMENT_STATUSES = [
	"draft",
	"running",
	"done",
	"locked",
] as const;

export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

const KEY_LINE = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/;

function unquoteScalar(raw: string): string {
	const trimmed = raw.trim().split(/\s+#/)[0]?.trim() ?? "";
	if (
		trimmed.length >= 2 &&
		((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
			(trimmed.startsWith("'") && trimmed.endsWith("'")))
	) {
		return trimmed.slice(1, -1);
	}
	return trimmed;
}

function topLevelScalar(line: string): { key: string; value: string } | null {
	if (!line || line.startsWith("#") || /^\s/.test(line)) return null;
	const match = KEY_LINE.exec(line);
	if (!match?.[1]) return null;
	return { key: match[1], value: unquoteScalar(match[2] ?? "") };
}

/**
 * Read `type` / `status` from a frontmatter interior (no fences).
 * Only the first top-level occurrence of each key counts.
 * Returns null when this block is not an experiment.
 */
export function readExperiment(
	interior: string,
): { status: ExperimentStatus | null } | null {
	let type: string | null = null;
	let status: string | null = null;
	for (const line of interior.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (trimmed === "---" || trimmed === "...") break;
		const field = topLevelScalar(line);
		if (!field) continue;
		if (field.key === "type" && type === null) type = field.value;
		if (field.key === "status" && status === null) status = field.value;
	}
	if (type !== "experiment") return null;
	const known = EXPERIMENT_STATUSES.find((item) => item === status) ?? null;
	return { status: known };
}

/**
 * Replace the first top-level `status` line, or insert one after `type`.
 * Every other line is copied unchanged.
 */
export function withExperimentStatus(
	interior: string,
	status: ExperimentStatus,
): string {
	const lines = interior.split(/\r?\n/);
	let statusAt = -1;
	let typeAt = -1;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		const trimmed = line.trim();
		if (trimmed === "---" || trimmed === "...") break;
		const field = topLevelScalar(line);
		if (!field) continue;
		if (field.key === "status" && statusAt < 0) statusAt = index;
		if (field.key === "type" && typeAt < 0) typeAt = index;
	}
	const next = `status: ${status}`;
	if (statusAt >= 0) {
		lines[statusAt] = next;
		return lines.join("\n");
	}
	lines.splice(typeAt >= 0 ? typeAt + 1 : 0, 0, next);
	return lines.join("\n");
}

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

/** New experiment note in the active language. Frontmatter tokens stay English. */
export function experimentNoteMarkdown(
	tableId: string,
	tablePath: string,
): string {
	const purpose = i18n.t("editor:experiment.purpose");
	const steps = i18n.t("editor:experiment.steps");
	const results = i18n.t("editor:experiment.results");
	const embed = researchTableDirective(tablePath, tableId);
	return `---\ntype: experiment\nstatus: draft\n---\n\n## ${purpose}\n\n## ${steps}\n\n## ${results}\n\n${embed}\n`;
}
