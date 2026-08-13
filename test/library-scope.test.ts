import { describe, expect, it } from "vitest";
import type { PaperMetadata } from "@/lib/paper";
import {
	filterPapersByScope,
	isPapersLibraryScope,
	LIBRARY_VIRTUAL_PATH,
	libraryDropParentDir,
	normalizeLibraryScope,
	paperInLibraryScope,
	resolveLibraryScopePath,
} from "@/lib/paper/api";
import {
	createPlaceholderTab,
	ensureFullLibraryTab,
	removeTab,
} from "@/lib/workspace/tabs";

function paper(
	path: string,
	overrides: Partial<PaperMetadata> = {},
): PaperMetadata {
	return {
		id: path.split("/").pop() ?? path,
		path,
		type: "arxiv",
		title: path,
		authors: [],
		tags: [],
		status: "completed",
		added_at: "",
		updated_at: "",
		...overrides,
	};
}

describe("normalizeLibraryScope", () => {
	it("strips slashes and lowercases", () => {
		expect(normalizeLibraryScope("Papers/NLP/")).toBe("papers/nlp");
		expect(normalizeLibraryScope("\\papers\\nlp\\")).toBe("papers/nlp");
	});
});

describe("isPapersLibraryScope / resolveLibraryScopePath", () => {
	it("accepts papers and papers/* only", () => {
		expect(isPapersLibraryScope("papers")).toBe(true);
		expect(isPapersLibraryScope("papers/nlp")).toBe(true);
		expect(isPapersLibraryScope("Papers/NLP")).toBe(true);
		expect(isPapersLibraryScope("notes")).toBe(false);
		expect(isPapersLibraryScope(".agents")).toBe(false);
		expect(isPapersLibraryScope("plans")).toBe(false);
		expect(isPapersLibraryScope(null)).toBe(false);
		expect(isPapersLibraryScope("")).toBe(false);
	});

	it("resolves non-papers folders to null (full library)", () => {
		expect(resolveLibraryScopePath("papers/nlp")).toBe("papers/nlp");
		expect(resolveLibraryScopePath("notes")).toBe(null);
		expect(resolveLibraryScopePath(".agents/skills")).toBe(null);
		expect(resolveLibraryScopePath("plans/week")).toBe(null);
		expect(resolveLibraryScopePath("")).toBe(null);
	});
});

describe("libraryDropParentDir", () => {
	it("uses the papers folder scope as the import dest", () => {
		expect(libraryDropParentDir("papers/nlp", "papers")).toBe("papers/nlp");
		expect(libraryDropParentDir("papers", "papers/other")).toBe("papers");
	});

	it("falls back for full library / non-papers scopes", () => {
		expect(libraryDropParentDir(null, "papers/cv")).toBe("papers/cv");
		expect(libraryDropParentDir("", "papers")).toBe("papers");
		expect(libraryDropParentDir("notes", "papers")).toBe("papers");
		expect(libraryDropParentDir(undefined, "")).toBe("papers");
	});
});

describe("paperInLibraryScope", () => {
	it("matches recursive path prefixes", () => {
		expect(paperInLibraryScope("papers/nlp/1706.03762", "papers/nlp")).toBe(
			true,
		);
		expect(paperInLibraryScope("papers/nlp/transformers/x", "papers/nlp")).toBe(
			true,
		);
		expect(paperInLibraryScope("papers/cv/y", "papers/nlp")).toBe(false);
		expect(paperInLibraryScope("papers/nlp-extra/z", "papers/nlp")).toBe(false);
	});

	it("treats null/empty scope as full library", () => {
		expect(paperInLibraryScope("papers/a", null)).toBe(true);
		expect(paperInLibraryScope("papers/a", "")).toBe(true);
		expect(paperInLibraryScope(undefined, "papers")).toBe(false);
	});

	it("treats notes/.agents/plans as full library (#160)", () => {
		expect(paperInLibraryScope("papers/a", "notes")).toBe(true);
		expect(paperInLibraryScope("papers/a", ".agents")).toBe(true);
		expect(paperInLibraryScope("papers/a", "plans")).toBe(true);
	});
});

describe("filterPapersByScope", () => {
	const rows = [
		paper("papers/1706.03762"),
		paper("papers/nlp/2010.11929"),
		paper("papers/nlp/transformers/bert"),
		paper("papers/cv/resnet"),
	];

	it("returns all papers for null scope", () => {
		expect(filterPapersByScope(rows, null)).toHaveLength(4);
	});

	it("filters papers/nlp recursively", () => {
		const hit = filterPapersByScope(rows, "papers/nlp");
		expect(hit.map((p) => p.path)).toEqual([
			"papers/nlp/2010.11929",
			"papers/nlp/transformers/bert",
		]);
	});

	it("filters papers root", () => {
		expect(filterPapersByScope(rows, "papers")).toHaveLength(4);
	});

	it("returns all papers for non-papers folder scopes (#160)", () => {
		expect(filterPapersByScope(rows, "notes")).toHaveLength(4);
		expect(filterPapersByScope(rows, ".agents")).toHaveLength(4);
		expect(filterPapersByScope(rows, "plans/todo")).toHaveLength(4);
	});
});

describe("filterPapersByScope latency", () => {
	it("stays well under a frame budget across catalog sizes", () => {
		const sizes = [100, 1_000, 5_000, 10_000, 50_000] as const;
		const results: string[] = [];

		for (const n of sizes) {
			const rows: PaperMetadata[] = [];
			for (let i = 0; i < n; i++) {
				const org = i % 20 === 0 ? "nlp" : i % 20 === 1 ? "cv" : `org${i % 50}`;
				rows.push(paper(`papers/${org}/paper-${i}`));
			}
			// Warm JIT / allocator before timing (cold first call skews CI averages).
			for (let w = 0; w < 5; w++) {
				filterPapersByScope(rows, "papers/nlp");
			}
			const iterations = n >= 10_000 ? 30 : 100;
			const samples: number[] = [];
			let hits = 0;
			for (let i = 0; i < iterations; i++) {
				const t0 = performance.now();
				hits = filterPapersByScope(rows, "papers/nlp").length;
				samples.push(performance.now() - t0);
			}
			samples.sort((a, b) => a - b);
			// Median resists single GC/noisy spikes that pull the mean over a hard
			// ceiling on shared CI runners (GHA previously flaked at ~52ms mean).
			const medianMs = samples[Math.floor(samples.length / 2)] ?? 0;
			const avgMs = samples.reduce((a, b) => a + b, 0) / samples.length;
			results.push(
				`n=${String(n).padStart(5)} median=${medianMs.toFixed(3)}ms avg=${avgMs.toFixed(3)}ms hits=${hits}`,
			);
			// Local n=50k is ~10ms; O(n²) would be hundreds of ms+. Ceiling leaves
			// headroom for GHA load while still catching real algorithmic blowups.
			expect(medianMs).toBeLessThan(100);
			expect(hits).toBeGreaterThan(0);
		}

		// eslint-disable-next-line no-console
		console.log(`[library-scope latency]\n  ${results.join("\n  ")}`);
	});
});

describe("ensureFullLibraryTab", () => {
	it("inserts full library when strip is empty", () => {
		const { tabs, activeId, inserted } = ensureFullLibraryTab([]);
		expect(inserted).toBe(true);
		expect(tabs).toHaveLength(1);
		expect(tabs[0]?.path).toBe(LIBRARY_VIRTUAL_PATH);
		expect(tabs[0]?.kind).toBe("library");
		expect(tabs[0]?.loaded).toBe(true);
		expect(activeId).toBe(LIBRARY_VIRTUAL_PATH);
	});

	it("reuses existing full library tab", () => {
		const start = [createPlaceholderTab(LIBRARY_VIRTUAL_PATH)];
		const { tabs, inserted } = ensureFullLibraryTab(start);
		expect(inserted).toBe(false);
		expect(tabs).toBe(start);
	});
});

describe("removeTab + ensureFullLibraryTab", () => {
	it("can rebuild library after the last document closes", () => {
		const doc = createPlaceholderTab("/vault/notes/a.md");
		const { tabs } = removeTab([doc], doc.id);
		expect(tabs).toHaveLength(0);
		const ensured = ensureFullLibraryTab(tabs);
		expect(ensured.tabs[0]?.path).toBe(LIBRARY_VIRTUAL_PATH);
	});
});
