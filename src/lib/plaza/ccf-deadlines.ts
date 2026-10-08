/**
 * 广场（Plaza）— CCF conference deadlines (native panel data).
 *
 * Reads the dataset published by the upstream ccf-deadlines project and owned
 * by its CI — we never author or manage conference data ourselves. The slim
 * `initial.json` carries the retained latest/upcoming editions (fast first
 * paint); every future submission deadline is flattened, cached, and sorted
 * ascending so the panel is a plain "what's due next" list.
 *
 * @see https://github.com/ccfddl/ccf-deadlines
 */

import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";

/** Canonical public site (also the panel's upstream escape hatch). */
export const CCF_DEADLINES_SOURCE_URL = "https://ccfddl.com/";

/** Slim public dataset: latest + upcoming editions only. */
export const CCF_DEADLINES_DATA_URL =
	"https://ccfddl.com/conference/initial.json";

const CACHE_KEY = "plaza:ccf-deadlines:v1";

export type CcfRank = "A" | "B" | "C" | "N";

/** One upcoming submission deadline, ready to render. */
export type CcfDeadlineItem = {
	/** Stable render key: conference + edition + raw deadline. */
	key: string;
	title: string;
	rank: CcfRank;
	/** Edition id, e.g. `aaai26`. */
	editionId: string;
	year: number;
	/** Venue-local deadline string, `YYYY-MM-DD HH:MM:SS`. */
	deadline: string;
	/** Upstream timezone label, e.g. `AoE`, `UTC-8`. */
	timezone: string;
	/** Optional round / track note from upstream. */
	comment?: string;
	/** Official conference or edition site. */
	link: string;
	/** Parsed instant (epoch ms); null only for an unknown timezone label. */
	at: number | null;
};

type RawTimelineNode = { deadline?: unknown; comment?: unknown };
type RawEdition = {
	id?: unknown;
	year?: unknown;
	link?: unknown;
	timezone?: unknown;
	timeline?: unknown;
};
type RawConference = {
	title?: unknown;
	conference_key?: unknown;
	rank?: { ccf?: unknown } | null;
	confs?: unknown;
};

/** UTC offset (hours) for the upstream timezone labels; null when unknown. */
export function ccfTimezoneOffsetHours(timezone: string): number | null {
	const tz = timezone.trim();
	if (tz === "AoE") return -12; // Anywhere on Earth
	if (tz === "PT") return -8; // US Pacific (approx; DST may shift by 1h)
	const match = /^UTC([+-]\d+(?:\.\d+)?)?$/.exec(tz);
	if (!match) return null;
	return match[1] ? Number(match[1]) : 0;
}

/** Parse a venue-local `YYYY-MM-DD HH:MM:SS` deadline into an epoch instant. */
export function ccfDeadlineInstant(
	deadline: string,
	timezone: string,
): number | null {
	const offset = ccfTimezoneOffsetHours(timezone);
	if (offset === null) return null;
	const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(
		deadline.trim(),
	);
	if (!match) return null;
	const [, year, month, day, hour, minute, second] = match;
	return (
		Date.UTC(
			Number(year),
			Number(month) - 1,
			Number(day),
			Number(hour),
			Number(minute),
			Number(second),
		) -
		offset * 3_600_000
	);
}

function isRank(value: unknown): value is CcfRank {
	return value === "A" || value === "B" || value === "C" || value === "N";
}

/**
 * Flatten upstream payload into future deadlines sorted ascending. `TBD` and
 * past deadlines are dropped; an unknown timezone keeps the item but sorts last.
 */
export function parseCcfDeadlines(
	payload: unknown,
	now: number,
): CcfDeadlineItem[] {
	const conferences = (payload as { conferences?: unknown } | null)
		?.conferences;
	if (!Array.isArray(conferences)) return [];

	const items: CcfDeadlineItem[] = [];
	for (const raw of conferences as RawConference[]) {
		if (!raw || typeof raw !== "object") continue;
		const rank = raw.rank?.ccf;
		if (!isRank(rank)) continue;
		const title = typeof raw.title === "string" ? raw.title : "";
		if (!title) continue;
		const conferenceKey =
			typeof raw.conference_key === "string" ? raw.conference_key : title;
		const editions = Array.isArray(raw.confs)
			? (raw.confs as RawEdition[])
			: [];

		for (const edition of editions) {
			if (!edition || typeof edition !== "object") continue;
			const timezone =
				typeof edition.timezone === "string" ? edition.timezone : "";
			const timeline = Array.isArray(edition.timeline)
				? (edition.timeline as RawTimelineNode[])
				: [];
			const editionId = typeof edition.id === "string" ? edition.id : "";
			const year = typeof edition.year === "number" ? edition.year : 0;
			const link = typeof edition.link === "string" ? edition.link : "";

			for (const node of timeline) {
				if (!node || typeof node !== "object") continue;
				const deadline =
					typeof node.deadline === "string" ? node.deadline.trim() : "";
				if (!deadline || deadline === "TBD") continue;
				const at = ccfDeadlineInstant(deadline, timezone);
				if (at !== null && at < now) continue;
				const comment =
					typeof node.comment === "string" ? node.comment.trim() : "";
				items.push({
					key: `${conferenceKey}:${editionId || year}:${deadline}`,
					title,
					rank,
					editionId,
					year,
					deadline,
					timezone,
					comment: comment || undefined,
					link,
					at,
				});
			}
		}
	}

	items.sort((a, b) => {
		if (a.at === null && b.at === null) return a.title.localeCompare(b.title);
		if (a.at === null) return 1;
		if (b.at === null) return -1;
		return a.at - b.at;
	});
	return items;
}

type CcfCache = { fetchedAt: number; items: CcfDeadlineItem[] };

function readCache(): CcfCache | null {
	const cached = readJsonStorage<CcfCache | null>(CACHE_KEY, null);
	if (
		!cached ||
		typeof cached.fetchedAt !== "number" ||
		!Array.isArray(cached.items)
	) {
		return null;
	}
	return cached;
}

/**
 * Fetch the latest upcoming deadlines. Always hits the network (the panel
 * refreshes on every open); the cache is only a fallback so an offline open
 * still shows the last known list.
 */
export async function loadCcfDeadlines(): Promise<CcfDeadlineItem[]> {
	const now = Date.now();
	try {
		const response = await fetch(CCF_DEADLINES_DATA_URL, {
			headers: { Accept: "application/json" },
		});
		if (!response.ok) {
			throw new Error(`CCF deadlines request failed (${response.status})`);
		}
		const payload = await response.json();
		const items = parseCcfDeadlines(payload, now);
		writeJsonStorage(CACHE_KEY, { fetchedAt: now, items } satisfies CcfCache);
		return items;
	} catch (error) {
		const cached = readCache();
		if (cached) {
			return cached.items.filter((item) => item.at === null || item.at >= now);
		}
		throw error;
	}
}
