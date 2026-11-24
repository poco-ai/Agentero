import { z } from "zod";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";

const API_URL = "https://huggingface.co/api/daily_papers";
const PAGE_SIZE = 50;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const HUGGING_FACE_FEED_MODES = [
	"trending",
	"daily",
	"weekly",
	"monthly",
] as const;
export const HUGGING_FACE_SORTS = [
	"default",
	"upvotes",
	"stars",
	"comments",
] as const;

export type HuggingFaceFeedMode = (typeof HUGGING_FACE_FEED_MODES)[number];
export type HuggingFaceSort = (typeof HUGGING_FACE_SORTS)[number];

const PREFS_KEY = "plaza:huggingface:prefs";
const prefsSchema = z.object({
	mode: z.enum(HUGGING_FACE_FEED_MODES),
	sort: z.enum(HUGGING_FACE_SORTS),
	codeOnly: z.boolean(),
});
type HuggingFacePrefs = z.infer<typeof prefsSchema>;

export function readHuggingFacePrefs(): HuggingFacePrefs {
	const parsed = prefsSchema.safeParse(
		readJsonStorage<unknown>(PREFS_KEY, null),
	);
	return parsed.success
		? parsed.data
		: { mode: "trending", sort: "default", codeOnly: false };
}

export function writeHuggingFacePrefs(prefs: HuggingFacePrefs): void {
	writeJsonStorage(PREFS_KEY, prefs);
}

const organization = z
	.object({ fullname: z.string().nullish(), name: z.string().nullish() })
	.nullish();
const count = z.number().int().nonnegative().nullish();
const dailyPaper = z.object({
	thumbnail: z.unknown().optional(),
	organization,
	publishedAt: z.string().nullish(),
	numComments: count,
	paper: z.object({
		id: z.string().regex(/^\d{4}\.\d{4,5}(?:v\d+)?$/),
		title: z.string().trim().min(1),
		summary: z.string().trim().nullish(),
		ai_summary: z.string().nullish(),
		ai_keywords: z.array(z.string()).nullish(),
		authors: z
			.array(z.object({ name: z.string(), hidden: z.boolean().nullish() }))
			.nullish(),
		organization,
		upvotes: count,
		githubRepo: z.unknown().optional(),
		githubStars: count,
		projectPage: z.unknown().optional(),
		submittedOnDailyAt: z.string().nullish(),
		publishedAt: z.string().nullish(),
	}),
});

export type HuggingFacePaper = {
	arxivId: string;
	title: string;
	abstract: string;
	aiSummary: string | null;
	aiKeywords: string[];
	authors: string[];
	organization: string | null;
	upvotes?: number;
	numComments?: number;
	githubRepo: string | null;
	githubStars?: number;
	projectPage: string | null;
	edition: string | null;
	publishedDate: string | null;
	thumbnail: string | null;
};

export type HuggingFaceFeedRequest =
	| { mode: "trending" }
	| { mode: "daily"; date: string; autoFallback?: boolean }
	| { mode: "weekly"; week: string }
	| { mode: "monthly"; month: string };

type HuggingFacePage = {
	papers: HuggingFacePaper[];
	hasMore: boolean;
	resolvedDate?: string;
};

export function todayUtcDate(now = new Date()): string {
	if (!Number.isFinite(now.getTime())) return "";
	const date = now.toISOString().split("T")[0];
	return DATE_PATTERN.test(date) ? date : "";
}

function parseUtcDate(date: string): number {
	if (!DATE_PATTERN.test(date)) return NaN;
	const utc = new Date(`${date}T00:00:00Z`);
	return todayUtcDate(utc) === date ? utc.getTime() : NaN;
}

export function shiftUtcDate(date: string, deltaDays: number): string {
	if (!Number.isInteger(deltaDays)) return date;
	return (
		todayUtcDate(new Date(parseUtcDate(date) + deltaDays * DAY_MS)) || date
	);
}

function firstIsoThursday(year: string): number {
	const jan4 = new Date(`${year}-01-04T00:00:00Z`);
	return jan4.getTime() + (4 - (jan4.getUTCDay() || 7)) * DAY_MS;
}

export function currentUtcIsoWeek(now = new Date()): string {
	const midnight = parseUtcDate(todayUtcDate(now));
	const thursday = midnight + (4 - (now.getUTCDay() || 7)) * DAY_MS;
	const date = todayUtcDate(new Date(thursday));
	if (!date) return "";
	const year = date.slice(0, 4);
	const week = 1 + (thursday - firstIsoThursday(year)) / WEEK_MS;
	return `${year}-W${String(week).padStart(2, "0")}`;
}

export function shiftIsoWeek(week: string, deltaWeeks: number): string {
	const match = /^(\d{4})-W(0[1-9]|[1-4]\d|5[0-3])$/.exec(week);
	if (!match || !Number.isInteger(deltaWeeks)) return week;
	const thursday =
		firstIsoThursday(match[1]) + (Number(match[2]) - 1) * WEEK_MS;
	if (currentUtcIsoWeek(new Date(thursday)) !== week) return week;
	return currentUtcIsoWeek(new Date(thursday + deltaWeeks * WEEK_MS)) || week;
}

export function currentUtcMonth(now = new Date()): string {
	return todayUtcDate(now).slice(0, 7);
}

export function shiftUtcMonth(month: string, deltaMonths: number): string {
	if (
		!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) ||
		!Number.isInteger(deltaMonths)
	) {
		return month;
	}
	const date = new Date(`${month}-01T00:00:00Z`);
	date.setUTCMonth(date.getUTCMonth() + deltaMonths);
	return currentUtcMonth(date) || month;
}

function safeWebUrl(value: unknown, origin?: string): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value.trim());
		return (url.protocol === "https:" || url.protocol === "http:") &&
			!url.username &&
			!url.password &&
			(!origin || url.origin === origin)
			? url.href
			: null;
	} catch {
		return null;
	}
}

const RESERVED_GITHUB_OWNERS = new Set([
	"about",
	"account",
	"apps",
	"codespaces",
	"collections",
	"copilot",
	"customer-stories",
	"education",
	"enterprise",
	"events",
	"explore",
	"features",
	"issues",
	"join",
	"login",
	"logout",
	"marketplace",
	"new",
	"nonprofit",
	"notifications",
	"open-source",
	"organizations",
	"orgs",
	"pricing",
	"pulls",
	"readme",
	"search",
	"security",
	"sessions",
	"settings",
	"signup",
	"site",
	"solutions",
	"sponsors",
	"team",
	"topics",
	"trending",
	"users",
	"watching",
]);
const GITHUB_OWNER_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/i;
const GITHUB_REPO_PATTERN = /^[a-z0-9._-]+$/i;

function safeGitHubRepoUrl(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value.trim());
		if (
			(url.protocol !== "https:" && url.protocol !== "http:") ||
			url.username ||
			url.password ||
			(url.hostname !== "github.com" && url.hostname !== "www.github.com")
		) {
			return null;
		}
		const segments = url.pathname.split("/").filter(Boolean);
		const [owner, repo, subpage] = segments;
		if (
			!owner ||
			!repo ||
			repo === "." ||
			repo === ".." ||
			!GITHUB_OWNER_PATTERN.test(owner) ||
			!GITHUB_REPO_PATTERN.test(repo) ||
			RESERVED_GITHUB_OWNERS.has(owner.toLowerCase())
		) {
			return null;
		}
		if (segments.length === 2 || (segments.length >= 4 && subpage === "tree")) {
			return url.href;
		}
		return null;
	} catch {
		return null;
	}
}

function paperDate(value: string | null | undefined): string | null {
	const date = value?.match(/^\d{4}-\d{2}-\d{2}(?=T|$)/)?.[0];
	return date && Number.isFinite(parseUtcDate(date)) ? date : null;
}

function parsePapers(payload: unknown[]): HuggingFacePaper[] {
	const papers = new Map<string, HuggingFacePaper>();
	for (const row of payload) {
		const parsed = dailyPaper.safeParse(row);
		if (!parsed.success) continue;
		const { paper, ...entry } = parsed.data;
		const arxivId = paper.id.replace(/v\d+$/, "");
		if (papers.has(arxivId)) continue;
		const organization = [
			entry.organization?.fullname,
			entry.organization?.name,
			paper.organization?.fullname,
			paper.organization?.name,
		]
			.map((name) => name?.trim())
			.find(Boolean);
		papers.set(arxivId, {
			arxivId,
			title: paper.title,
			abstract: paper.summary ?? "",
			aiSummary: paper.ai_summary?.trim() || null,
			aiKeywords: [
				...new Set(
					paper.ai_keywords?.map((word) => word.trim()).filter(Boolean),
				),
			],
			authors: (paper.authors ?? [])
				.filter((author) => !author.hidden)
				.map((author) => author.name),
			organization: organization ?? null,
			upvotes: paper.upvotes ?? undefined,
			numComments: entry.numComments ?? undefined,
			githubRepo: safeGitHubRepoUrl(paper.githubRepo),
			githubStars: paper.githubStars ?? undefined,
			projectPage: safeWebUrl(paper.projectPage),
			edition: paperDate(paper.submittedOnDailyAt),
			publishedDate:
				paperDate(paper.publishedAt) ?? paperDate(entry.publishedAt),
			thumbnail: safeWebUrl(
				entry.thumbnail,
				"https://cdn-thumbnails.huggingface.co",
			),
		});
	}
	if (payload.length > 0 && papers.size === 0) {
		throw new Error("Unexpected Hugging Face Daily Papers response");
	}
	return [...papers.values()];
}

function throwIfAborted(signal: AbortSignal): void {
	if (!signal.aborted) return;
	if (typeof DOMException === "function") {
		throw new DOMException("The operation was aborted.", "AbortError");
	}
	const error = new Error("The operation was aborted.");
	error.name = "AbortError";
	throw error;
}

async function fetchPage(
	request: HuggingFaceFeedRequest,
	page: number,
	signal: AbortSignal,
): Promise<unknown[]> {
	throwIfAborted(signal);
	const url = new URL(API_URL);
	url.searchParams.set("limit", String(PAGE_SIZE));
	url.searchParams.set("p", String(page));
	switch (request.mode) {
		case "daily":
			url.searchParams.set("date", request.date);
			break;
		case "weekly":
			url.searchParams.set("week", request.week);
			break;
		case "monthly":
			url.searchParams.set("month", request.month);
			break;
		default:
			url.searchParams.set("sort", "trending");
	}
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const payload = z.array(z.unknown()).parse(await response.json());
	throwIfAborted(signal);
	return payload;
}

export async function loadHuggingFacePapers(
	request: HuggingFaceFeedRequest & { page?: number },
	signal: AbortSignal,
): Promise<HuggingFacePage> {
	const page = request.page ?? 0;
	let payload = await fetchPage(request, page, signal);
	let resolvedDate = request.mode === "daily" ? request.date : undefined;
	if (request.mode === "daily" && request.autoFallback && page === 0) {
		for (let offset = 1; payload.length === 0 && offset <= 4; offset++) {
			const date = shiftUtcDate(request.date, -offset);
			if (date === request.date) break;
			payload = await fetchPage({ mode: "daily", date }, page, signal);
			if (payload.length > 0) resolvedDate = date;
		}
	}
	return {
		papers: parsePapers(payload),
		hasMore: payload.length >= PAGE_SIZE,
		resolvedDate,
	};
}

export function filterAndSortHuggingFacePapers(
	papers: readonly HuggingFacePaper[],
	{
		sort,
		query,
		codeOnly,
	}: { sort: HuggingFaceSort; query: string; codeOnly: boolean },
): HuggingFacePaper[] {
	const needle = query.trim().toLowerCase();
	const visible = papers.filter(
		(paper) =>
			(!codeOnly || Boolean(paper.githubRepo)) &&
			(!needle ||
				[
					paper.title,
					paper.organization,
					...paper.authors,
					...paper.aiKeywords,
					paper.aiSummary,
					paper.abstract,
					paper.arxivId,
				].some((field) => field?.toLowerCase().includes(needle))),
	);
	if (sort === "default") return visible;
	const metric = (
		{
			upvotes: "upvotes",
			stars: "githubStars",
			comments: "numComments",
		} as const
	)[sort];
	// Stable Array.sort preserves feed order when both metrics tie.
	return visible.sort(
		(a, b) =>
			(b[metric] ?? -1) - (a[metric] ?? -1) ||
			(b.upvotes ?? -1) - (a.upvotes ?? -1),
	);
}

const compactCount = new Intl.NumberFormat("en", {
	notation: "compact",
	maximumFractionDigits: 1,
});

export function formatCompactCount(value: number): string {
	return compactCount.format(value).replace("K", "k");
}
