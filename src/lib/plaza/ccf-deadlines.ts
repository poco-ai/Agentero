/**
 * 广场（Plaza）— CCF conference deadlines (native panel data).
 *
 * Reads the dataset published by the upstream ccf-deadlines project and owned
 * by its CI — we never author or manage conference data ourselves. The slim
 * `initial.json` carries the retained latest/upcoming editions (fast first
 * paint); every future submission deadline is flattened, cached, and sorted
 * ascending so the panel is a plain "what's due next" list.
 *
 * `initial.json` also advertises (via `archive`) a content-hashed history part
 * holding every past edition. A conference whose next cycle is not announced
 * yet has no upcoming deadline and would otherwise vanish, so we estimate its
 * next one from the most recent past edition (same month/day, weekday kept).
 * Estimates are flagged `estimated` and never override an official date.
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

/** Estimate only while the last known cycle is recent enough to recur. */
const ESTIMATE_RECENT_MS = 548 * 86_400_000; // ~18 months
/** Estimate only when the projected deadline lands within the next year. */
const ESTIMATE_HORIZON_MS = 365 * 86_400_000; // ~12 months

export type CcfRank = "A" | "B" | "C" | "N";

/** One upcoming submission deadline, ready to render. */
export type CcfDeadlineItem = {
	/** Stable render key: conference + edition + raw deadline. */
	key: string;
	title: string;
	rank: CcfRank;
	/** Edition id, e.g. `aaai26`. Empty for estimated items. */
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
	/** True when derived from a past edition (next cycle not yet announced). */
	estimated?: boolean;
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

/** One concrete deadline lifted out of an upstream conference payload. */
type RawDeadline = {
	title: string;
	rank: CcfRank;
	conferenceKey: string;
	editionId: string;
	year: number;
	link: string;
	timezone: string;
	/** Venue-local `YYYY-MM-DD HH:MM:SS`; blanks and `TBD` already dropped. */
	deadline: string;
	/** Parsed instant; null for an unknown timezone label. */
	at: number | null;
	comment?: string;
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

/**
 * Project a venue-local deadline one year forward, keeping its weekday (most
 * venues anchor to e.g. "last Thursday of January"). Returns the shifted
 * `YYYY-MM-DD HH:MM:SS` string, or null when the input is malformed.
 */
export function ccfNextYearDeadline(deadline: string): string | null {
	const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(
		deadline.trim(),
	);
	if (!match) return null;
	const [, rawYear, rawMonth, rawDay, hour, minute, second] = match;
	const year = Number(rawYear) + 1;
	const month = Number(rawMonth);
	const day = Number(rawDay);
	const weekday = new Date(
		Date.UTC(Number(rawYear), month - 1, day),
	).getUTCDay();
	const maxDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
	for (const offset of [0, 1, -1, 2, -2, 3, -3]) {
		const candidate = day + offset;
		if (candidate < 1 || candidate > maxDay) continue;
		if (
			new Date(Date.UTC(year, month - 1, candidate)).getUTCDay() === weekday
		) {
			const mm = String(month).padStart(2, "0");
			const dd = String(candidate).padStart(2, "0");
			return `${year}-${mm}-${dd} ${hour}:${minute}:${second}`;
		}
	}
	return null;
}

function isRank(value: unknown): value is CcfRank {
	return value === "A" || value === "B" || value === "C" || value === "N";
}

/** Lifts every concrete (non-`TBD`) deadline out of one or more payloads. */
function* iterDeadlines(payloads: readonly unknown[]): Generator<RawDeadline> {
	for (const payload of payloads) {
		const outer = payload as { conferences?: unknown } | null;
		const conferences = Array.isArray(payload) ? payload : outer?.conferences;
		if (!Array.isArray(conferences)) continue;

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
					const comment =
						typeof node.comment === "string" ? node.comment.trim() : "";
					yield {
						title,
						rank,
						conferenceKey,
						editionId,
						year,
						link,
						timezone,
						deadline,
						at: ccfDeadlineInstant(deadline, timezone),
						comment: comment || undefined,
					};
				}
			}
		}
	}
}

function compareItems(a: CcfDeadlineItem, b: CcfDeadlineItem): number {
	if (a.at === null && b.at === null) return a.title.localeCompare(b.title);
	if (a.at === null) return 1;
	if (b.at === null) return -1;
	return a.at - b.at;
}

/**
 * Flatten upstream payload into future deadlines sorted ascending. `TBD` and
 * past deadlines are dropped; an unknown timezone keeps the item but sorts last.
 */
export function parseCcfDeadlines(
	payload: unknown,
	now: number,
): CcfDeadlineItem[] {
	const items: CcfDeadlineItem[] = [];
	for (const raw of iterDeadlines([payload])) {
		if (raw.at !== null && raw.at < now) continue;
		items.push({
			key: `${raw.conferenceKey}:${raw.editionId || raw.year}:${raw.deadline}`,
			title: raw.title,
			rank: raw.rank,
			editionId: raw.editionId,
			year: raw.year,
			deadline: raw.deadline,
			timezone: raw.timezone,
			comment: raw.comment,
			link: raw.link,
			at: raw.at,
		});
	}
	return items.sort(compareItems);
}

/**
 * Estimate the next deadline for CCF A/B/C conferences whose next cycle is not
 * announced yet (i.e. they have no future official deadline). Uses the latest
 * past edition, projected one year forward with its weekday preserved, and is
 * bounded to recent cycles plus the coming year so stale or distant guesses
 * never surface.
 */
export function predictCcfDeadlines(
	payloads: readonly unknown[],
	now: number,
): CcfDeadlineItem[] {
	const groups = new Map<string, RawDeadline[]>();
	for (const raw of iterDeadlines(payloads)) {
		if (raw.rank === "N") continue;
		const list = groups.get(raw.conferenceKey);
		if (list) list.push(raw);
		else groups.set(raw.conferenceKey, [raw]);
	}

	const items: CcfDeadlineItem[] = [];
	for (const [conferenceKey, deadlines] of groups) {
		let hasFuture = false;
		let latest: RawDeadline | null = null;
		for (const raw of deadlines) {
			if (raw.at === null) continue;
			if (raw.at >= now) {
				hasFuture = true;
				break;
			}
			if (latest === null || (latest.at !== null && raw.at > latest.at)) {
				latest = raw;
			}
		}
		if (hasFuture || latest === null || latest.at === null) continue;
		if (latest.at < now - ESTIMATE_RECENT_MS) continue;

		const projected = ccfNextYearDeadline(latest.deadline);
		if (!projected) continue;
		const at = ccfDeadlineInstant(projected, latest.timezone);
		if (at === null || at < now || at > now + ESTIMATE_HORIZON_MS) continue;

		items.push({
			key: `${conferenceKey}:est:${projected}`,
			title: latest.title,
			rank: latest.rank,
			editionId: "",
			year: Number(projected.slice(0, 4)),
			deadline: projected,
			timezone: latest.timezone,
			link: latest.link,
			at,
			estimated: true,
		});
	}
	return items.sort(compareItems);
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

/** Resolve the content-hashed history part advertised by `initial.json`. */
function resolveArchiveUrl(payload: unknown): string | null {
	const archive = (payload as { archive?: unknown } | null)?.archive;
	if (typeof archive !== "string" || !archive.trim()) return null;
	try {
		return new URL(archive, CCF_DEADLINES_DATA_URL).href;
	} catch {
		return null;
	}
}

/**
 * Best-effort fetch of the history part to estimate unannounced cycles. Any
 * failure (offline, missing part) degrades to "official deadlines only".
 */
async function loadEstimatedDeadlines(
	payload: unknown,
	now: number,
): Promise<CcfDeadlineItem[]> {
	const archiveUrl = resolveArchiveUrl(payload);
	if (!archiveUrl) return [];
	try {
		const response = await fetch(archiveUrl, {
			headers: { Accept: "application/json" },
		});
		if (!response.ok) return [];
		const history = await response.json();
		return predictCcfDeadlines([payload, history], now);
	} catch {
		return [];
	}
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
		const official = parseCcfDeadlines(payload, now);
		const estimated = await loadEstimatedDeadlines(payload, now);
		const items = [...official, ...estimated].sort(compareItems);
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
