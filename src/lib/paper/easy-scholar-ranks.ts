/**
 * Selectable EasyScholar rank systems.
 *
 * The Host already writes every supported `#easyscholar:` tag at sync time, so
 * this registry only decides what the Library and Paper Info may display.
 * Filtering happens in the renderer: toggling a system costs no API call and
 * never rewrites paper metadata.
 *
 * Ids match the EasyScholar response field names (`sci`, `sciUp`, …) with the
 * numeric metrics (`if`, `if5`, `jci`) kept alongside them. Keep this list in
 * sync with `EASY_SCHOLAR_RANK_IDS` in the Host settings module and
 * `rank_label` in `easy_scholar.rs`.
 */
import {
	EASY_SCHOLAR_TAG_PREFIX,
	isEasyScholarTagName,
} from "@/lib/paper/tag-namespaces";

export const EASY_SCHOLAR_RANK_IDS = [
	"if",
	"if5",
	"jci",
	"sci",
	"ssci",
	"eii",
	"cssci",
	"pku",
	"ccf",
	"fms",
	"utd24",
] as const;

export type EasyScholarRankId = (typeof EASY_SCHOLAR_RANK_IDS)[number];

/** Every supported system is visible until the user narrows the selection. */
export const DEFAULT_EASY_SCHOLAR_RANKS: readonly EasyScholarRankId[] =
	EASY_SCHOLAR_RANK_IDS;

export function isEasyScholarRankId(v: unknown): v is EasyScholarRankId {
	return (
		typeof v === "string" &&
		(EASY_SCHOLAR_RANK_IDS as readonly string[]).includes(v)
	);
}

/**
 * Keep only known ids, dedupe, and restore canonical order. An empty array is
 * meaningful ("hide all rank metrics") and therefore preserved.
 */
export function normalizeEasyScholarRanks(raw: unknown): EasyScholarRankId[] {
	const selected = new Set(
		Array.isArray(raw) ? raw.filter(isEasyScholarRankId) : [],
	);
	return EASY_SCHOLAR_RANK_IDS.filter((id) => selected.has(id));
}

/** Host `rank=` labels → registry ids (labels are Host-owned, not i18n). */
const RANK_TAG_LABELS: Record<string, EasyScholarRankId> = {
	SCI: "sci",
	SSCI: "ssci",
	EI检索: "eii",
	CSSCI: "cssci",
	北大中文核心: "pku",
	CCF: "ccf",
	FMS: "fms",
	UTD24: "utd24",
};

/**
 * Registry id a stored metric tag belongs to, or null for legacy/unknown tags.
 * The Host writes `if=`, `if5=`, `jci=` and `rank=<label>[=<value>]`.
 */
export function easyScholarRankIdFromTagName(
	name: string,
): EasyScholarRankId | null {
	if (!isEasyScholarTagName(name)) return null;
	const rest = name.trim().slice(EASY_SCHOLAR_TAG_PREFIX.length);
	const eq = rest.indexOf("=");
	const key = (eq === -1 ? rest : rest.slice(0, eq)).trim().toLowerCase();
	const value = eq === -1 ? "" : rest.slice(eq + 1).trim();
	if (key === "if" || key === "if5" || key === "jci") return key;
	if (key !== "rank") return null;
	const label = value.split("=")[0]?.trim() ?? "";
	return RANK_TAG_LABELS[label.toLocaleUpperCase()] ?? null;
}
