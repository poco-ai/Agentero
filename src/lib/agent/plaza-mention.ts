/**
 * Plaza entries (arXiv Daily / Feeds) as Agent `@` mention targets.
 *
 * These items live in Host-side stores (catalog recommend cache /
 * feeds.sqlite), never on the Vault filesystem, so their mention chips carry
 * a virtual `agentero:plaza/...` path and the send pipeline expands the
 * registered metadata (title / source / URL / abstract) into the prompt text
 * instead of listing a file for the agent to read.
 */

import type { TFunction } from "i18next";

export const PLAZA_MENTION_PREFIX = "agentero:plaza/";
const ARXIV_REC_SEGMENT = "arxiv-rec";
const FEEDS_SEGMENT = "feeds";

export type PlazaMentionSource = "arxiv-rec" | "feed";

export type PlazaMentionEntry = {
	/** Virtual path used as the `{{m:…}}` mention identity. */
	path: string;
	source: PlazaMentionSource;
	title: string;
	url: string | null;
	abstract: string | null;
	publishedAt: string | null;
	/** "arXiv Daily" (localized) or the feed subscription title. */
	sourceLabel: string;
};

export function arxivRecMentionPath(arxivId: string): string {
	return `${PLAZA_MENTION_PREFIX}${ARXIV_REC_SEGMENT}/${arxivId.trim()}`;
}

export function feedMentionPath(feedItemId: string): string {
	return `${PLAZA_MENTION_PREFIX}${FEEDS_SEGMENT}/${feedItemId.trim()}`;
}

export function isPlazaMentionPath(path: string | null | undefined): boolean {
	return Boolean(path?.startsWith(PLAZA_MENTION_PREFIX));
}

/** Which plaza source a virtual mention path points at (null for vault paths). */
export function plazaMentionSource(
	path: string | null | undefined,
): PlazaMentionSource | null {
	if (!isPlazaMentionPath(path)) return null;
	return path?.startsWith(`${PLAZA_MENTION_PREFIX}${FEEDS_SEGMENT}/`)
		? "feed"
		: "arxiv-rec";
}

/**
 * Module-level registry: candidates registered by the composer data source
 * before they can show in the `@` menu, so send-time expansion never needs IO.
 * `registerPlazaMentionEntries` replaces the whole set (vault switch reload).
 */
const entryByPath = new Map<string, PlazaMentionEntry>();

export function registerPlazaMentionEntries(
	entries: readonly PlazaMentionEntry[],
): void {
	entryByPath.clear();
	for (const entry of entries) {
		if (!entry.path) continue;
		entryByPath.set(entry.path, entry);
	}
}

export function lookupPlazaMention(
	path: string | null | undefined,
): PlazaMentionEntry | null {
	if (!isPlazaMentionPath(path)) return null;
	return entryByPath.get(path as string) ?? null;
}

/** Full title for chip / menu display, or null for vault paths / stale drafts. */
export function plazaMentionTitle(
	path: string | null | undefined,
): string | null {
	return lookupPlazaMention(path)?.title.trim() || null;
}

export type SplitContextPaths = {
	vaultPaths: string[];
	plazaPaths: string[];
};

/** Split composer context paths into filesystem targets and virtual plaza refs. */
export function splitContextPaths(paths: readonly string[]): SplitContextPaths {
	const vaultPaths: string[] = [];
	const plazaPaths: string[] = [];
	for (const path of paths) {
		if (isPlazaMentionPath(path)) plazaPaths.push(path);
		else vaultPaths.push(path);
	}
	return { vaultPaths, plazaPaths };
}

function entryBlock(entry: PlazaMentionEntry): string {
	const lines = [`### ${entry.title || entry.path}`];
	lines.push(`- Source: ${entry.sourceLabel}`);
	if (entry.url) lines.push(`- URL: ${entry.url}`);
	if (entry.publishedAt) lines.push(`- Published: ${entry.publishedAt}`);
	if (entry.abstract) {
		lines.push("Abstract:", entry.abstract);
	}
	return lines.join("\n");
}

/**
 * Prompt block for @-mentioned plaza entries. Registered entries expand to
 * their metadata; stale paths (e.g. a draft restored after a daily refresh)
 * degrade to an explicit unavailable note instead of silently dropping.
 */
export function plazaMentionPromptBlock(options: {
	plazaPaths: readonly string[];
	t: TFunction<"agent", undefined>;
}): string {
	const paths = options.plazaPaths.filter(Boolean);
	if (paths.length === 0) return "";
	const blocks = paths.map((path) => {
		const entry = lookupPlazaMention(path);
		return entry
			? entryBlock(entry)
			: `### ${path}\n- ${options.t("composer.plazaEntryUnavailable")}`;
	});
	return `${options.t("composer.plazaContextInstruction")}\n\n${blocks.join("\n\n")}`;
}
