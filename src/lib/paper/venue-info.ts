/**
 * Derived venue presentation for the Library table and Paper Info.
 *
 * The catalog keeps `publication` as the authoritative venue and the Host keeps
 * `#submitted:` / `#easyscholar:` as compatibility projections. This module
 * turns those raw values into one display model.
 */
import {
	type EasyScholarRankId,
	easyScholarRankIdFromTagName,
} from "@/lib/paper/easy-scholar-ranks";
import {
	EASY_SCHOLAR_TAG_PREFIX,
	isEasyScholarTagName,
	isSubmittedTagName,
	SUBMITTED_TAG_PREFIX,
} from "@/lib/paper/tag-namespaces";
import { type PaperTagInput, tagName } from "@/lib/paper/tags";

export type VenueStatus = "published" | "submitted" | "preprint" | "none";

export type VenueInfo = {
	status: VenueStatus;
	/** Published venue, submission target, or repository name. */
	name: string | null;
	/** Full raw value for the cell tooltip. */
	fullName: string | null;
	/** Template-inferred submission target (not a verified submission). */
	inferred: boolean;
	/** Compact EasyScholar indicators, e.g. `CCF-A`, `IF 25.6`. */
	metrics: string[];
};

type VenueSource = {
	publication?: string | null;
	tags?: readonly PaperTagInput[] | null;
};

/**
 * Mirror of `is_repository_venue` in `crates/agentero-core/.../venue.rs`.
 * Keep the marker list in sync with the Host.
 */
const REPOSITORY_MARKERS = [
	"arxiv",
	"biorxiv",
	"medrxiv",
	"chemrxiv",
	"techrxiv",
	"ssrn",
	"research square",
	"researchesquare",
	"preprints.org",
	"osf preprint",
	"zenodo",
	"semantic scholar",
	"researchgate",
	"scienceopen",
	"openreview",
] as const;

export function isRepositoryVenue(name: string): boolean {
	const lower = name.trim().toLocaleLowerCase();
	return REPOSITORY_MARKERS.some((marker) => lower.includes(marker));
}

function repositoryLabel(name: string): string {
	const lower = name.toLocaleLowerCase();
	if (lower.includes("arxiv")) return "arXiv";
	if (lower.includes("biorxiv")) return "bioRxiv";
	if (lower.includes("medrxiv")) return "medRxiv";
	if (lower.includes("ssrn")) return "SSRN";
	if (lower.includes("zenodo")) return "Zenodo";
	return name.trim();
}

function submittedTarget(tags: readonly PaperTagInput[]): string | null {
	for (const tag of tags) {
		const name = tagName(tag).trim();
		if (!isSubmittedTagName(name)) continue;
		const target = name.slice(SUBMITTED_TAG_PREFIX.length).trim();
		if (target) return target;
	}
	return null;
}

function metricRank(label: string): number {
	if (label.startsWith("CCF")) return 0;
	if (label.startsWith("IF5")) return 2;
	if (label.startsWith("IF")) return 1;
	if (label.startsWith("JCI")) return 3;
	return 4;
}

export function formatEasyScholarMetric(name: string): string | null {
	if (!isEasyScholarTagName(name)) return null;
	const rest = name.trim().slice(EASY_SCHOLAR_TAG_PREFIX.length);
	const eq = rest.indexOf("=");
	const key = (eq === -1 ? rest : rest.slice(0, eq)).trim();
	const value = eq === -1 ? "" : rest.slice(eq + 1).trim();
	if (key === "journal") return null;
	if (key === "if") return value ? `IF ${value}` : "IF";
	if (key === "if5") return value ? `IF5 ${value}` : "IF5";
	if (key === "jci") return value ? `JCI ${value}` : "JCI";
	if (key === "rank") {
		const sep = value.indexOf("=");
		const indicator = (sep === -1 ? value : value.slice(0, sep)).trim();
		const level = sep === -1 ? "" : value.slice(sep + 1).trim();
		if (!indicator) return null;
		if (!level) return indicator;
		return indicator.toLocaleUpperCase() === "CCF"
			? `CCF-${level}`
			: `${indicator} ${level}`;
	}
	return value ? `${key} ${value}` : key || null;
}

/**
 * Compact metrics for one paper. `ranks` narrows the display to the systems
 * enabled in settings; omitted means "show every stored metric" (used by
 * non-UI callers such as sort keys).
 */
function venueMetrics(
	tags: readonly PaperTagInput[],
	ranks?: readonly EasyScholarRankId[],
): string[] {
	const enabled = ranks ? new Set(ranks) : null;
	const metrics = tags
		.map((tag) => {
			const name = tagName(tag);
			const id = easyScholarRankIdFromTagName(name);
			if (enabled && id !== null && !enabled.has(id)) return null;
			return formatEasyScholarMetric(name);
		})
		.filter((value): value is string => Boolean(value));
	return [...new Set(metrics)].sort(
		(a, b) => metricRank(a) - metricRank(b) || a.localeCompare(b),
	);
}

export function venueInfo(
	paper: VenueSource,
	ranks?: readonly EasyScholarRankId[],
): VenueInfo {
	const publication = paper.publication?.trim() ?? "";
	const tags = paper.tags ?? [];
	const submitted = submittedTarget(tags);
	const published = publication.length > 0 && !isRepositoryVenue(publication);

	if (published) {
		return {
			status: "published",
			name: publication,
			fullName: publication,
			inferred: false,
			metrics: venueMetrics(tags, ranks),
		};
	}
	if (submitted) {
		return {
			status: "submitted",
			name: submitted,
			fullName: submitted,
			inferred: true,
			metrics: [],
		};
	}
	if (publication) {
		return {
			status: "preprint",
			name: repositoryLabel(publication),
			fullName: publication,
			inferred: false,
			metrics: [],
		};
	}
	return {
		status: "none",
		name: null,
		fullName: null,
		inferred: false,
		metrics: [],
	};
}
