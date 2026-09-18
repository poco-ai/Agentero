import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import { filterMentionOptions } from "@/lib/agent/mention";
import {
	arxivRecMentionPath,
	feedMentionPath,
	isPlazaMentionPath,
	lookupPlazaMention,
	type PlazaMentionEntry,
	plazaMentionPromptBlock,
	plazaMentionSource,
	registerPlazaMentionEntries,
	splitContextPaths,
} from "@/lib/agent/plaza-mention";
import { assembleTurnPrompt } from "@/lib/agent/turn-prompt";

const t = ((key: string) => key) as unknown as TFunction<"agent", undefined>;

const recEntry: PlazaMentionEntry = {
	path: arxivRecMentionPath("2409.12345"),
	source: "arxiv-rec",
	title: "Scaling Laws for Sparse Towers",
	url: "https://arxiv.org/abs/2409.12345",
	abstract: "We study sparse transformer towers.",
	publishedAt: "2026-09-18",
	sourceLabel: "arXiv Daily",
};

const feedEntry: PlazaMentionEntry = {
	path: feedMentionPath("feed-1"),
	source: "feed",
	title: "Weekly GPU Review",
	url: "https://example.com/gpu",
	abstract: null,
	publishedAt: null,
	sourceLabel: "arXiv cs.LG",
};

describe("plaza mention paths", () => {
	it("builds and classifies virtual paths", () => {
		const rec = arxivRecMentionPath("2409.12345");
		const feed = feedMentionPath("feed-1");
		expect(isPlazaMentionPath(rec)).toBe(true);
		expect(isPlazaMentionPath(feed)).toBe(true);
		expect(isPlazaMentionPath("papers/notes/todo.md")).toBe(false);
		expect(plazaMentionSource(rec)).toBe("arxiv-rec");
		expect(plazaMentionSource(feed)).toBe("feed");
		expect(plazaMentionSource("papers/notes/todo.md")).toBeNull();
	});

	it("registering replaces the whole registry", () => {
		registerPlazaMentionEntries([recEntry, feedEntry]);
		expect(lookupPlazaMention(recEntry.path)?.title).toBe(recEntry.title);
		registerPlazaMentionEntries([feedEntry]);
		expect(lookupPlazaMention(recEntry.path)).toBeNull();
		expect(lookupPlazaMention(feedEntry.path)?.source).toBe("feed");
		registerPlazaMentionEntries([]);
	});

	it("splits composer context paths", () => {
		const { vaultPaths, plazaPaths } = splitContextPaths([
			"papers/a",
			recEntry.path,
			"notes/todo.md",
			feedEntry.path,
		]);
		expect(vaultPaths).toEqual(["papers/a", "notes/todo.md"]);
		expect(plazaPaths).toEqual([recEntry.path, feedEntry.path]);
	});
});

describe("filterMentionOptions with plaza candidates", () => {
	const candidates = ["notes", "papers/a", recEntry.path, feedEntry.path];
	const labels = new Map([
		[recEntry.path, `${recEntry.title} ${recEntry.sourceLabel}`],
		[feedEntry.path, `${feedEntry.title} ${feedEntry.sourceLabel}`],
	]);

	it("hides plaza entries on empty query unless they are recents", () => {
		expect(
			filterMentionOptions({ candidates, query: "", labelsByPath: labels }),
		).not.toContain(recEntry.path);
		const withRecent = filterMentionOptions({
			candidates,
			query: "",
			labelsByPath: labels,
			recent: [feedEntry.path],
		});
		expect(withRecent).toContain(feedEntry.path);
		expect(withRecent).not.toContain(recEntry.path);
	});

	it("surfaces plaza entries on title queries", () => {
		const hit = filterMentionOptions({
			candidates,
			query: "sparse towers",
			labelsByPath: labels,
		});
		expect(hit).toContain(recEntry.path);
		expect(hit).not.toContain(feedEntry.path);
	});

	it("never lists plaza entries inside a folder drill-down", () => {
		const children = filterMentionOptions({
			candidates,
			query: "",
			labelsByPath: labels,
			browseRoot: "papers",
		});
		expect(children).toEqual(["papers/a"]);
	});
});

describe("plaza mention prompt expansion", () => {
	it("expands registered entries and degrades stale ones", () => {
		registerPlazaMentionEntries([recEntry]);
		const block = plazaMentionPromptBlock({
			plazaPaths: [recEntry.path, feedEntry.path],
			t,
		});
		expect(block).toContain("composer.plazaContextInstruction");
		expect(block).toContain(`### ${recEntry.title}`);
		expect(block).toContain(`- Source: ${recEntry.sourceLabel}`);
		expect(block).toContain(`- URL: ${recEntry.url}`);
		expect(block).toContain(recEntry.abstract ?? "");
		expect(block).toContain(`### ${feedEntry.path}`);
		expect(block).toContain("composer.plazaEntryUnavailable");
		registerPlazaMentionEntries([]);
	});

	it("returns an empty block for no plaza paths", () => {
		expect(plazaMentionPromptBlock({ plazaPaths: [], t })).toBe("");
	});
});

describe("assembleTurnPrompt with plaza mentions", () => {
	it("splits vault bullets from the plaza block", () => {
		registerPlazaMentionEntries([recEntry]);
		const { prompt } = assembleTurnPrompt({
			text: "compare these",
			contextPaths: ["papers/a", recEntry.path],
			selections: [],
			visualDrafts: [],
			attachedImages: [],
			isAcpCommand: false,
			t,
		});
		expect(prompt).toContain("compare these");
		expect(prompt).toContain("- papers/a");
		expect(prompt).not.toContain(`- ${recEntry.path}`);
		expect(prompt).toContain(`### ${recEntry.title}`);
		registerPlazaMentionEntries([]);
	});

	it("omits the vault instruction when only plaza paths are attached", () => {
		registerPlazaMentionEntries([recEntry]);
		const { prompt } = assembleTurnPrompt({
			text: "summarize",
			contextPaths: [recEntry.path],
			selections: [],
			visualDrafts: [],
			attachedImages: [],
			isAcpCommand: false,
			t,
		});
		expect(prompt).not.toContain("composer.contextInstruction");
		expect(prompt).toContain(`### ${recEntry.title}`);
		registerPlazaMentionEntries([]);
	});
});
