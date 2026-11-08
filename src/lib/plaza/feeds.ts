/**
 * Plaza feed subscriptions — Host IPC + paper import.
 *
 * @see docs/development/plaza-feeds.md
 */

import { commands, type FeedItem, type FeedSub } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApi } from "@/lib/core/ipc";
import { notifyError } from "@/lib/core/notify";
import { lookupSubmit } from "@/lib/paper/import-actions";

/** Wire shapes from the generated bindings (feeds.sqlite rows). */
export type { FeedItem, FeedSub };

export type FeedFilter = "all" | "paper" | "other" | "unread";

export const ARXIV_FEED_CHIPS = [
	"cs.AI",
	"cs.CL",
	"cs.LG",
	"cs.CV",
	"stat.ML",
] as const;

/**
 * Full arXiv category list for autocomplete suggestions.
 * @see https://arxiv.org/category_taxonomy
 */
export const ARXIV_ALL_CATEGORIES: readonly string[] = [
	"cs.AI",
	"cs.AR",
	"cs.CC",
	"cs.CE",
	"cs.CG",
	"cs.CL",
	"cs.CR",
	"cs.CV",
	"cs.CY",
	"cs.DB",
	"cs.DC",
	"cs.DL",
	"cs.DM",
	"cs.DS",
	"cs.ET",
	"cs.FL",
	"cs.GL",
	"cs.GR",
	"cs.GT",
	"cs.HC",
	"cs.IR",
	"cs.IT",
	"cs.LG",
	"cs.LO",
	"cs.MA",
	"cs.MM",
	"cs.MS",
	"cs.NA",
	"cs.NE",
	"cs.NI",
	"cs.OH",
	"cs.OS",
	"cs.PF",
	"cs.PL",
	"cs.RO",
	"cs.SC",
	"cs.SD",
	"cs.SE",
	"cs.SI",
	"cs.SY",
	"econ.EM",
	"econ.GN",
	"econ.TH",
	"eess.AS",
	"eess.IV",
	"eess.SP",
	"eess.SY",
	"math.AC",
	"math.AG",
	"math.AP",
	"math.AT",
	"math.CO",
	"math.CT",
	"math.CV",
	"math.DG",
	"math.DS",
	"math.FA",
	"math.GM",
	"math.GN",
	"math.GR",
	"math.GT",
	"math.HO",
	"math.IT",
	"math.KT",
	"math.LO",
	"math.MG",
	"math.MP",
	"math.NA",
	"math.NT",
	"math.OA",
	"math.OC",
	"math.PR",
	"math.QA",
	"math.RA",
	"math.RT",
	"math.SG",
	"math.SP",
	"math.ST",
	"astro-ph.CO",
	"astro-ph.EP",
	"astro-ph.GA",
	"astro-ph.HE",
	"astro-ph.IM",
	"astro-ph.SR",
	"cond-mat.dis-nn",
	"cond-mat.mes-hall",
	"cond-mat.mtrl-sci",
	"cond-mat.other",
	"cond-mat.quant-gas",
	"cond-mat.soft",
	"cond-mat.stat-mech",
	"cond-mat.str-el",
	"cond-mat.supr-con",
	"gr-qc",
	"hep-ex",
	"hep-lat",
	"hep-ph",
	"hep-th",
	"math-ph",
	"nlin.AO",
	"nlin.CD",
	"nlin.CG",
	"nlin.PS",
	"nlin.SI",
	"nucl-ex",
	"nucl-th",
	"physics.acc-ph",
	"physics.ao-ph",
	"physics.app-ph",
	"physics.atm-clus",
	"physics.atom-ph",
	"physics.bio-ph",
	"physics.chem-ph",
	"physics.class-ph",
	"physics.comp-ph",
	"physics.data-an",
	"physics.ed-ph",
	"physics.flu-dyn",
	"physics.gen-ph",
	"physics.geo-ph",
	"physics.hist-ph",
	"physics.ins-det",
	"physics.med-ph",
	"physics.optics",
	"physics.plasm-ph",
	"physics.pop-ph",
	"physics.soc-ph",
	"physics.space-ph",
	"q-bio.BM",
	"q-bio.CB",
	"q-bio.GN",
	"q-bio.MN",
	"q-bio.NC",
	"q-bio.OT",
	"q-bio.PE",
	"q-bio.QM",
	"q-bio.SC",
	"q-bio.TO",
	"q-fin.CP",
	"q-fin.EC",
	"q-fin.GN",
	"q-fin.MF",
	"q-fin.PM",
	"q-fin.ST",
	"q-fin.TR",
	"quant-ph",
	"stat.AP",
	"stat.CO",
	"stat.ME",
	"stat.ML",
	"stat.OT",
	"stat.TH",
];

export function arxivFeedUrl(cat: string): string {
	return `https://rss.arxiv.org/rss/${cat}`;
}

const META_PREFIXES = [
	"arxiv:",
	"announce type:",
	"comments:",
	"subjects:",
	"journal-ref:",
	"report-no:",
	"license:",
	"abstract:",
] as const;

/**
 * Relative ("3 hours ago") then short-date feed timestamp. Kept next to the
 * feed display helpers so the list card and the Agent preview agree.
 */
export function formatFeedWhen(iso: string | null, locale: string): string {
	if (!iso) return "";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return "";
	const diffSec = Math.round((date.getTime() - Date.now()) / 1000);
	const abs = Math.abs(diffSec);
	const rtf = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
	if (abs < 60) return rtf.format(diffSec, "second");
	if (abs < 3600) return rtf.format(Math.round(diffSec / 60), "minute");
	if (abs < 86400) return rtf.format(Math.round(diffSec / 3600), "hour");
	if (abs < 86400 * 7) return rtf.format(Math.round(diffSec / 86400), "day");
	return new Intl.DateTimeFormat(locale, {
		month: "short",
		day: "numeric",
	}).format(date);
}

/**
 * Drop arXiv RSS headers so cards show the abstract, not the id / type.
 * Line breaks are preserved for callers that keep paragraph structure.
 */
export function stripFeedMeta(raw: string): string {
	let rest = raw.trim();
	for (;;) {
		const lower = rest.toLowerCase();
		const hit = META_PREFIXES.find((prefix) => lower.startsWith(prefix));
		if (!hit) break;
		const after = rest.slice(hit.length).trimStart();
		if (hit === "abstract:") {
			rest = after;
			continue;
		}
		const skip = after.search(/\s/);
		rest = (skip === -1 ? "" : after.slice(skip)).trimStart();
	}
	return rest;
}

export function cleanFeedSummary(raw: string): string {
	return stripTrailingEllipsis(
		stripFeedMeta(raw.replace(/<[^>]+>/g, " "))
			.replace(/\s+/g, " ")
			.trim(),
	);
}

/** Drop RSS teaser tails (`[...]`, `…`) from cards and the detail body. */
export function stripTrailingEllipsis(text: string): string {
	let rest = text.trim();
	for (;;) {
		const lower = rest.toLowerCase();
		let next = rest;
		if (lower.endsWith("[...]")) next = rest.slice(0, -5);
		else if (rest.endsWith("[…]")) next = rest.slice(0, -"[…]".length);
		else if (lower.endsWith("[..]")) next = rest.slice(0, -4);
		else if (rest.endsWith("...")) next = rest.slice(0, -3);
		else if (rest.endsWith("…")) next = rest.slice(0, -1);
		else break;
		rest = next.trimEnd();
	}
	return rest;
}

/** One Markdown document: `# Title` plus body, for `MessageResponse`. */
export function feedDetailMarkdown(item: FeedItem): string {
	const raw = item.bodyMarkdown?.trim() || cleanFeedSummary(item.summaryText);
	const body = stripTrailingEllipsis(raw);
	const title = item.title.trim();
	if (!title) return body;
	const first = body.split("\n")[0]?.trim() ?? "";
	const firstText = first.replace(/^#+\s*/, "").trim();
	const rest = body.split("\n").slice(1).join("\n").trim();
	if (firstText.toLowerCase() === title.toLowerCase()) {
		return rest ? `# ${title}\n\n${rest}` : `# ${title}`;
	}
	return body ? `# ${title}\n\n${body}` : `# ${title}`;
}

const SETTLE_TIMEOUT_MS = 120_000;

export async function feedsList(): Promise<FeedSub[]> {
	const data = await callApi(() => commands.feedsList(), {
		fallback: "feeds.listFailed",
	});
	return data.subscriptions;
}

export async function feedsAdd(url: string, title?: string): Promise<FeedSub> {
	return callApi(() => commands.feedsAdd({ url, title: title ?? null }), {
		fallback: "feeds.addFailed",
	});
}

export async function feedsRemove(id: string): Promise<void> {
	await callApi(() => commands.feedsRemove({ id }), {
		fallback: "feeds.removeFailed",
	});
}

export async function feedsRename(id: string, title: string): Promise<FeedSub> {
	return callApi(() => commands.feedsRename({ id, title }), {
		fallback: "feeds.renameFailed",
	});
}

export async function feedsRefresh(opts?: {
	id?: string;
	staleOnly?: boolean;
}): Promise<{ subscriptions: FeedSub[]; fetched: number; failed: number }> {
	return callApi(
		() =>
			commands.feedsRefresh({
				id: opts?.id ?? null,
				staleOnly: opts?.staleOnly ?? false,
			}),
		{ fallback: "feeds.refreshFailed" },
	);
}

export async function feedsItems(opts?: {
	subscriptionId?: string;
	filter?: FeedFilter;
	limit?: number;
	beforePublishedAt?: string;
	beforeId?: string;
}): Promise<FeedItem[]> {
	const data = await callApi(
		() =>
			commands.feedsItems({
				subscriptionId: opts?.subscriptionId ?? null,
				filter: opts?.filter ?? "all",
				limit: opts?.limit ?? 100,
				beforePublishedAt: opts?.beforePublishedAt ?? null,
				beforeId: opts?.beforeId ?? null,
			}),
		{ fallback: "feeds.itemsFailed" },
	);
	return data.items;
}

export async function feedsMarkImported(id: string): Promise<FeedItem> {
	return callApi(() => commands.feedsMarkImported({ id }), {
		fallback: "feeds.markFailed",
	});
}

export async function feedsSetPinned(
	id: string,
	pinned: boolean,
): Promise<FeedSub> {
	return callApi(() => commands.feedsSetPinned({ id, pinned }), {
		fallback: "feeds.pinFailed",
	});
}

export async function feedsResolveBody(id: string): Promise<FeedItem> {
	return callApi(() => commands.feedsResolveBody({ id }), {
		fallback: "feeds.resolveFailed",
	});
}

export function compareFeedSubs(a: FeedSub, b: FeedSub): number {
	if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
	if (a.pinned && b.pinned) {
		return (b.pinnedAt ?? "").localeCompare(a.pinnedAt ?? "");
	}
	return a.addedAt.localeCompare(b.addedAt);
}

/** Import a paper or webpage via the existing URL lookup flow. */
export function importFeedItem(item: FeedItem): Promise<boolean> {
	const url = item.paperUrl?.trim() || item.url?.trim();
	if (!url) return Promise.resolve(false);
	return new Promise<boolean>((resolve) => {
		let settled = false;
		const timer = setTimeout(() => settle(false), SETTLE_TIMEOUT_MS);
		function settle(ok: boolean) {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve(ok);
		}
		void lookupSubmit([url], {
			onComplete: (result) => {
				const ok =
					result.imported.length > 0 ||
					result.skipped.some(
						(row) =>
							row.reason === "already_in_library" ||
							row.reason === "duplicate_in_batch",
					);
				settle(ok);
			},
		}).catch((error) => {
			notifyError(errorText(error));
			settle(false);
		});
	});
}

const FEED_ERROR_KEYS = {
	invalid_url: "plaza.feeds.errors.invalid_url",
	duplicate: "plaza.feeds.errors.duplicate",
	not_found: "plaza.feeds.errors.not_found",
	empty_title: "plaza.feeds.errors.empty_title",
	empty: "plaza.feeds.errors.empty",
	no_feed: "plaza.feeds.errors.no_feed",
	too_large: "plaza.feeds.errors.too_large",
	parse: "plaza.feeds.errors.parse",
	http: "plaza.feeds.errors.http",
	fetch: "plaza.feeds.errors.fetch",
	body: "plaza.feeds.errors.body",
	// Operation-level codes: used when the Host error carries no message.
	listFailed: "plaza.feeds.errors.opFailed",
	addFailed: "plaza.feeds.errors.opFailed",
	removeFailed: "plaza.feeds.errors.opFailed",
	renameFailed: "plaza.feeds.errors.opFailed",
	refreshFailed: "plaza.feeds.errors.opFailed",
	itemsFailed: "plaza.feeds.errors.opFailed",
	markFailed: "plaza.feeds.errors.opFailed",
	pinFailed: "plaza.feeds.errors.opFailed",
	resolveFailed: "plaza.feeds.errors.opFailed",
} as const;

export type FeedErrorKey =
	(typeof FEED_ERROR_KEYS)[keyof typeof FEED_ERROR_KEYS];

export function hostErrorKey(message: string): FeedErrorKey | null {
	const text = message.trim();
	if (!text.startsWith("feeds.")) return null;
	const code = text.slice("feeds.".length).split(":")[0];
	return code in FEED_ERROR_KEYS
		? FEED_ERROR_KEYS[code as keyof typeof FEED_ERROR_KEYS]
		: null;
}

export async function feedsSetRead(
	id: string,
	read: boolean,
): Promise<FeedItem> {
	return callApi(() => commands.feedsSetRead({ id, read }), {
		fallback: "feeds.markFailed",
	});
}
