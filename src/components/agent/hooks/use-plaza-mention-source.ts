/**
 * Background `@` mention source for Plaza entries: the stored same-day
 * arXiv Daily run plus the newest feed items. Loads once per vault and
 * registers everything into the plaza-mention store for send-time
 * expansion. Failures are silent — the `@` menu just stays vault-only.
 */

import { useEffect, useState } from "react";
import type { PlazaMentionEntry } from "@/lib/agent/plaza-mention";
import {
	arxivRecMentionPath,
	feedMentionPath,
	registerPlazaMentionEntries,
} from "@/lib/agent/plaza-mention";
import type { FeedItem, RecommendItem } from "@/lib/core/bindings";
import { isTauri } from "@/lib/core/tauri";
import {
	cleanFeedSummary,
	feedsItems,
	stripTrailingEllipsis,
} from "@/lib/plaza/feeds";
import { PLAZA_SOURCES, plazaSourceLabel } from "@/lib/plaza/sources";
import { recommendArxivLast } from "@/lib/recommend";

const FEED_MENTION_LIMIT = 60;

const ARXIV_REC_SOURCE = PLAZA_SOURCES.find((s) => s.id === "arxiv-rec");

/** Resolved lazily so i18n is initialized before the label is read. */
function arxivRecSourceLabel(): string {
	return ARXIV_REC_SOURCE ? plazaSourceLabel(ARXIV_REC_SOURCE) : "arXiv Daily";
}

function entryFromRecommend(item: RecommendItem): PlazaMentionEntry {
	return {
		path: arxivRecMentionPath(item.arxivId),
		source: "arxiv-rec",
		title: item.title.trim(),
		url: item.url?.trim() || null,
		abstract: item.abstract?.trim() || null,
		publishedAt: item.publishedAt,
		sourceLabel: arxivRecSourceLabel(),
	};
}

function entryFromFeedItem(item: FeedItem): PlazaMentionEntry {
	const rawAbstract = item.bodyMarkdown?.trim() || item.summaryText;
	return {
		path: feedMentionPath(item.id),
		source: "feed",
		title: item.title.trim(),
		url: item.paperUrl?.trim() || item.url?.trim() || null,
		abstract: stripTrailingEllipsis(cleanFeedSummary(rawAbstract)) || null,
		publishedAt: item.publishedAt,
		sourceLabel: item.subscriptionTitle?.trim() || "Feeds",
	};
}

/** Loaded plaza entries (also registered globally for prompt expansion). */
export function usePlazaMentionSource(
	vaultPath: string | null,
): PlazaMentionEntry[] {
	const [entries, setEntries] = useState<PlazaMentionEntry[]>([]);

	useEffect(() => {
		// Drop the previous vault's entries and registry first: until the new
		// loads land, stale recommendations must not stay mentionable or
		// expandable into a prompt (and no vault must keep any registry).
		setEntries([]);
		registerPlazaMentionEntries([]);
		if (!vaultPath || !isTauri()) {
			return;
		}
		let cancelled = false;
		void (async () => {
			const [rec, feedItems] = await Promise.all([
				recommendArxivLast(vaultPath).catch(() => null),
				feedsItems({ limit: FEED_MENTION_LIMIT }).catch(() => []),
			]);
			if (cancelled) return;
			const next: PlazaMentionEntry[] = [
				...(rec?.items ?? []).map(entryFromRecommend),
				...(feedItems ?? []).map(entryFromFeedItem),
			];
			registerPlazaMentionEntries(next);
			setEntries(next);
		})();
		return () => {
			cancelled = true;
		};
	}, [vaultPath]);

	return entries;
}
