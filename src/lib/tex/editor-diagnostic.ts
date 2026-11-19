export type LintSeverity = "error" | "warning" | "info";

/** Presentation order shared by every diagnostics list: red errors first. */
export const LINT_SEVERITY_ORDER: readonly LintSeverity[] = [
	"error",
	"warning",
	"info",
];

/** Numeric rank for list sorting (lower = more urgent). */
export function lintSeverityRank(severity: LintSeverity): number {
	return LINT_SEVERITY_ORDER.indexOf(severity);
}

/**
 * Stable severity order for the editor footer and the writing problems card /
 * build log: a failed build's red rows lead, then warnings, then advisories.
 * `Array.prototype.sort` is stable, so rows keep their original order inside a
 * severity (log position, source order) instead of being reshuffled.
 */
export function sortBySeverity<T extends { severity: LintSeverity }>(
	rows: readonly T[],
): T[] {
	return [...rows].sort(
		(a, b) => lintSeverityRank(a.severity) - lintSeverityRank(b.severity),
	);
}

export type EditorDiagnostic = {
	from: number;
	to: number;
	severity: LintSeverity;
	message: string;
	source?: string;
	/** 1-based position of the diagnostic start, IDE-style. */
	line: number;
	column: number;
};
