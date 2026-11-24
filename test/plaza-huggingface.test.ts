// @vitest-environment happy-dom
import { act, createElement, type ReactNode, StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PlazaHuggingFaceView } from "@/components/plaza/plaza-huggingface-view";
import { TooltipProvider } from "@/components/ui/tooltip";
import "@/i18n";
import { notifyError } from "@/lib/core/notify";
import {
	currentUtcIsoWeek,
	currentUtcMonth,
	filterAndSortHuggingFacePapers,
	formatCompactCount,
	type HuggingFaceFeedRequest,
	loadHuggingFacePapers,
	readHuggingFacePrefs,
	shiftIsoWeek,
	shiftUtcDate,
	shiftUtcMonth,
	todayUtcDate,
	writeHuggingFacePrefs,
} from "@/lib/plaza/huggingface";
import { runTranslate } from "@/lib/translate";
import { openRemoteArxivPaper } from "@/lib/workspace/actions";
import { deferred } from "./helpers/deferred";
import { type Mounted, mountRoot } from "./helpers/mount";

vi.mock("@/hooks/use-app-stores", () => {
	const vault = { vaultPath: null, tree: [] };
	const library = { papers: [] };
	return {
		useVaultStore: (selector: (state: typeof vault) => unknown) =>
			selector(vault),
		useLibraryStore: (selector: (state: typeof library) => unknown) =>
			selector(library),
	};
});
vi.mock("@/components/selection/selection-surface", () => ({
	SelectionSurface: ({ children }: { children: ReactNode }) =>
		createElement("div", { "data-summary": true }, children),
}));
vi.mock("@/components/sidebar/file-tree/move-destination-picker", () => ({
	MoveDestinationPicker: () => null,
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: vi.fn() }));
vi.mock("@/lib/paper/library-actions", () => ({
	currentLookupParentDir: vi.fn(),
}));
vi.mock("@/lib/plaza/import", () => ({ importPlazaPaper: vi.fn() }));
vi.mock("@/lib/translate", () => ({ runTranslate: vi.fn() }));
vi.mock("@/lib/workspace/actions", () => ({ openRemoteArxivPaper: vi.fn() }));

const fetchMock = vi.fn<typeof fetch>();
const prefsKey = "plaza:huggingface:prefs";
const signal = new AbortController().signal;

function row(index: number, fields: Record<string, unknown> = {}) {
	return {
		paper: {
			id: `2611.${String(index).padStart(5, "0")}`,
			title: `Paper ${index}`,
			...fields,
		},
	};
}

function response(rows: unknown[]) {
	return new Response(JSON.stringify(rows));
}

function queryParams(call = 0) {
	return new URL(String(fetchMock.mock.calls[call][0])).searchParams;
}

beforeEach(() => {
	vi.clearAllMocks();
	fetchMock.mockReset();
	vi.stubGlobal("fetch", fetchMock);
	localStorage.removeItem(prefsKey);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("Hugging Face papers API", () => {
	const requests: [
		HuggingFaceFeedRequest & { page?: number },
		Record<string, string>,
	][] = [
		[{ mode: "trending" }, { sort: "trending", p: "0" }],
		[
			{ mode: "trending", page: 1 },
			{ sort: "trending", p: "1" },
		],
		[
			{ mode: "daily", date: "2026-11-23" },
			{ date: "2026-11-23", p: "0" },
		],
		[
			{ mode: "weekly", week: "2026-W48", page: 2 },
			{ week: "2026-W48", p: "2" },
		],
		[
			{ mode: "monthly", month: "2026-11" },
			{ month: "2026-11", p: "0" },
		],
	];
	it.each(
		requests,
	)("sends exactly the query parameters for %j", async (request, expected) => {
		fetchMock.mockResolvedValueOnce(response([]));
		await loadHuggingFacePapers(request, signal);
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const [url, options] = fetchMock.mock.calls[0];
		expect(new URL(String(url)).origin + new URL(String(url)).pathname).toBe(
			"https://huggingface.co/api/daily_papers",
		);
		expect(Object.fromEntries(queryParams())).toEqual({
			limit: "50",
			...expected,
		});
		expect(options?.signal).toBe(signal);
	});

	it("walks back to the first populated daily edition and uses the raw page size", async () => {
		fetchMock
			.mockResolvedValueOnce(response([]))
			.mockResolvedValueOnce(response([]))
			.mockResolvedValueOnce(
				response(Array.from({ length: 50 }, () => row(1))),
			);
		const page = await loadHuggingFacePapers(
			{
				mode: "daily",
				date: "2026-11-22",
				autoFallback: true,
			},
			signal,
		);
		expect(
			fetchMock.mock.calls.map((_, index) => queryParams(index).get("date")),
		).toEqual(["2026-11-22", "2026-11-21", "2026-11-20"]);
		expect(page.resolvedDate).toBe("2026-11-20");
		expect(page.hasMore).toBe(true);
		expect(page.papers).toHaveLength(1);
	});

	it("uses the selected date when fallback is disabled", async () => {
		fetchMock.mockResolvedValueOnce(response([]));
		expect(
			await loadHuggingFacePapers(
				{
					mode: "daily",
					date: "2026-11-22",
					autoFallback: false,
				},
				signal,
			),
		).toEqual({ papers: [], resolvedDate: "2026-11-22", hasMore: false });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("tries up to four earlier days and retains the original date when all are empty", async () => {
		fetchMock.mockImplementation(async () => response([]));
		expect(
			await loadHuggingFacePapers(
				{
					mode: "daily",
					date: "2026-11-22",
					autoFallback: true,
				},
				signal,
			),
		).toEqual({ papers: [], resolvedDate: "2026-11-22", hasMore: false });
		expect(fetchMock).toHaveBeenCalledTimes(5);
	});

	it("aborts without fetching when the signal lacks throwIfAborted", async () => {
		const abortedSignal = { aborted: true } as AbortSignal;
		await expect(
			loadHuggingFacePapers({ mode: "trending" }, abortedSignal),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("aborts before requesting another fallback day", async () => {
		const controller = new AbortController();
		fetchMock.mockImplementationOnce(async () => {
			controller.abort();
			return response([]);
		});
		await expect(
			loadHuggingFacePapers(
				{
					mode: "daily",
					date: "2026-11-22",
					autoFallback: true,
				},
				controller.signal,
			),
		).rejects.toMatchObject({ name: "AbortError" });
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it.each([
		[" https://github.com/org/repo ", "https://github.com/org/repo"],
		["http://www.github.com/org/repo/", "http://www.github.com/org/repo/"],
		[
			"https://github.com/org/repo/tree/main/paper",
			"https://github.com/org/repo/tree/main/paper",
		],
		["https://example.org/project/repo", null],
		["https://example.org/project", null],
		["https://github.com/", null],
		["https://github.com/org", null],
		["https://github.com/orgs/huggingface/repositories", null],
		["https://github.com/settings/profile", null],
		["https://github.com/org/repo/issues", null],
		["https://user:password@github.com/org/repo", null],
		["ftp://github.com/org/repo", null],
	])("validates GitHub repository URL %s before filtering", async (url, expected) => {
		fetchMock.mockResolvedValueOnce(response([row(1, { githubRepo: url })]));
		const { papers } = await loadHuggingFacePapers(
			{ mode: "trending" },
			signal,
		);
		expect(papers[0].githubRepo).toBe(expected);
		expect(
			filterAndSortHuggingFacePapers(papers, {
				sort: "default",
				query: "",
				codeOnly: true,
			}),
		).toEqual(expected ? papers : []);
	});

	it("normalizes metadata and rejects unsafe links while accepting sparse rows", async () => {
		const complete = {
			...row(1, {
				id: "2611.00001v3",
				title: "  A paper  ",
				summary: "Full abstract",
				ai_summary: "  AI summary  ",
				ai_keywords: [" vision ", "vision", " ", "language"],
				authors: [{ name: "Ada" }, { name: "Secret", hidden: true }],
				organization: { fullname: "Nested organization" },
				upvotes: 42,
				githubRepo: " https://github.com/org/repo ",
				githubStars: 1412,
				projectPage: " http://project.example/paper ",
				submittedOnDailyAt: "2026-11-23T05:12:00Z",
				publishedAt: "2026-11-20T00:00:00Z",
			}),
			numComments: 3,
			organization: { fullname: " ", name: " Row organization " },
			publishedAt: "2026-11-24",
			thumbnail: "https://cdn-thumbnails.huggingface.co/cover.png",
		};
		fetchMock.mockResolvedValueOnce(
			response([
				complete,
				{
					...row(2, {
						githubRepo: "javascript:alert(1)",
						projectPage: "file:///tmp/index",
						organization: { fullname: " Other organization " },
					}),
					publishedAt: "2026-11-19",
					thumbnail: "https://example.com/cover.png",
				},
				{
					...row(3, {
						githubRepo: "https://user@github.com/org/repo",
						projectPage: "http://user:password@project.example",
					}),
					thumbnail: "https://user@cdn-thumbnails.huggingface.co/cover.png",
				},
				row(4),
			]),
		);
		const { papers } = await loadHuggingFacePapers(
			{ mode: "trending" },
			signal,
		);
		expect(papers).toEqual([
			{
				arxivId: "2611.00001",
				title: "A paper",
				abstract: "Full abstract",
				aiSummary: "AI summary",
				aiKeywords: ["vision", "language"],
				authors: ["Ada"],
				organization: "Row organization",
				upvotes: 42,
				numComments: 3,
				githubRepo: "https://github.com/org/repo",
				githubStars: 1412,
				projectPage: "http://project.example/paper",
				edition: "2026-11-23",
				publishedDate: "2026-11-20",
				thumbnail: "https://cdn-thumbnails.huggingface.co/cover.png",
			},
			expect.objectContaining({
				organization: "Other organization",
				edition: null,
				publishedDate: "2026-11-19",
				githubRepo: null,
				projectPage: null,
				thumbnail: null,
			}),
			expect.objectContaining({
				githubRepo: null,
				projectPage: null,
				thumbnail: null,
			}),
			expect.objectContaining({
				arxivId: "2611.00004",
				abstract: "",
				aiSummary: null,
				aiKeywords: [],
				authors: [],
			}),
		]);
	});
});

describe("Hugging Face feed helpers", () => {
	it("uses UTC for dates and strict ISO weeks across year boundaries", () => {
		const now = new Date("2021-01-01T00:30:00+02:00");
		expect(todayUtcDate(now)).toBe("2020-12-31");
		expect(currentUtcMonth(now)).toBe("2020-12");
		expect(currentUtcIsoWeek(now)).toBe("2020-W53");
		expect(currentUtcIsoWeek(new Date("2018-12-31T00:00:00Z"))).toBe(
			"2019-W01",
		);
		expect(shiftUtcDate("2024-03-01", -1)).toBe("2024-02-29");
		expect(shiftUtcDate("2026-01-01", -1)).toBe("2025-12-31");
		expect(shiftIsoWeek("2026-W01", -1)).toBe("2025-W52");
		expect(shiftIsoWeek("2020-W53", 1)).toBe("2021-W01");
		expect(shiftUtcMonth("2026-01", -1)).toBe("2025-12");
		expect(shiftUtcMonth("2026-12", 1)).toBe("2027-01");
		expect(shiftUtcDate("2026-02-30", 1)).toBe("2026-02-30");
		expect(shiftIsoWeek("2025-W53", 1)).toBe("2025-W53");
		expect(shiftUtcMonth("2026-13", 1)).toBe("2026-13");
		expect(todayUtcDate(new Date(NaN))).toBe("");
	});

	it("keeps sort ties stable and puts missing counts after zero", async () => {
		fetchMock.mockResolvedValueOnce(
			response([
				{ ...row(1, { upvotes: 4 }), numComments: 2 },
				row(2, { upvotes: 1, githubStars: 0 }),
				{ ...row(3, { upvotes: 5, githubStars: 0 }), numComments: 2 },
				{ ...row(4, { upvotes: 5, githubStars: 10 }), numComments: 0 },
				{ ...row(5, { upvotes: 5, githubStars: 10 }), numComments: 0 },
			]),
		);
		const { papers } = await loadHuggingFacePapers(
			{ mode: "trending" },
			signal,
		);
		const sorted = (sort: "default" | "upvotes" | "stars" | "comments") =>
			filterAndSortHuggingFacePapers(papers, {
				sort,
				query: "",
				codeOnly: false,
			}).map((paper) => paper.title);
		expect(sorted("default")).toEqual([
			"Paper 1",
			"Paper 2",
			"Paper 3",
			"Paper 4",
			"Paper 5",
		]);
		expect(sorted("upvotes")).toEqual([
			"Paper 3",
			"Paper 4",
			"Paper 5",
			"Paper 1",
			"Paper 2",
		]);
		expect(sorted("stars")).toEqual([
			"Paper 4",
			"Paper 5",
			"Paper 3",
			"Paper 2",
			"Paper 1",
		]);
		expect(sorted("comments")).toEqual([
			"Paper 3",
			"Paper 1",
			"Paper 4",
			"Paper 5",
			"Paper 2",
		]);
		expect(papers[0].title).toBe("Paper 1");
	});

	it("matches all searchable fields and filters for GitHub repositories", async () => {
		fetchMock.mockResolvedValueOnce(
			response([
				row(1, {
					title: "Transformers",
					organization: { name: "Research Lab" },
					authors: [{ name: "Ada" }],
					ai_keywords: ["vision"],
					ai_summary: "contrastive",
					summary: "retrieval",
					githubRepo: "https://github.com/org/repo",
				}),
				row(2),
			]),
		);
		const { papers } = await loadHuggingFacePapers(
			{ mode: "trending" },
			signal,
		);
		const filter = (query: string, codeOnly = false) =>
			filterAndSortHuggingFacePapers(papers, {
				sort: "default",
				query,
				codeOnly,
			});
		for (const query of [
			"  TRANSFORMERS ",
			"research",
			"ADA",
			"VISION",
			"contrastive",
			"retrieval",
			"2611.00001",
		]) {
			expect(filter(query)).toEqual([papers[0]]);
		}
		expect(filter("", true)).toEqual([papers[0]]);
		expect(filter("missing")).toEqual([]);
	});

	it("formats compact counts and validates saved preferences", () => {
		expect([999, 1412, 32515].map(formatCompactCount)).toEqual([
			"999",
			"1.4k",
			"32.5k",
		]);
		const defaults = { mode: "trending", sort: "default", codeOnly: false };
		expect(readHuggingFacePrefs()).toEqual(defaults);
		localStorage.setItem(
			prefsKey,
			'{"mode":"unknown","sort":"default","codeOnly":true}',
		);
		expect(readHuggingFacePrefs()).toEqual(defaults);
		const prefs = { mode: "weekly", sort: "stars", codeOnly: true } as const;
		writeHuggingFacePrefs(prefs);
		expect(readHuggingFacePrefs()).toEqual(prefs);
	});
});

describe("Hugging Face Papers Plaza", () => {
	let view: Mounted;
	const loadMore = () => button("Load more");

	beforeEach(() => {
		view = mountRoot();
	});
	afterEach(async () => {
		await view.unmount();
	});

	async function render() {
		await view.render(
			createElement(TooltipProvider, null, createElement(PlazaHuggingFaceView)),
		);
	}

	function button(label: string) {
		return Array.from(view.container.querySelectorAll("button")).find(
			(element) =>
				(element.getAttribute("aria-label") ?? element.textContent) === label,
		);
	}

	async function click(label: string) {
		const element = button(label);
		if (!element) throw new Error(`Missing button: ${label}`);
		await act(async () => element.click());
	}

	function titles() {
		return Array.from(
			view.container.querySelectorAll("article h2"),
			(el) => el.textContent,
		);
	}

	async function renderDailyDateInput() {
		vi.setSystemTime(new Date("2026-11-24T12:00:00Z"));
		writeHuggingFacePrefs({ mode: "daily", sort: "default", codeOnly: false });
		fetchMock.mockResolvedValueOnce(response([row(1)]));
		await render();
		const input =
			view.container.querySelector<HTMLInputElement>('input[type="date"]');
		if (!input) throw new Error("Missing daily date input");
		return input;
	}

	async function editDate(input: HTMLInputElement, date: string) {
		await act(() => {
			input.focus();
			// Bypass React's value tracker to simulate a native input edit.
			Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)?.set?.call(input, date);
			input.dispatchEvent(new Event("input", { bubbles: true }));
		});
	}

	it("defaults to Trending and uses the correct period when switching modes", async () => {
		vi.setSystemTime(new Date("2026-11-22T12:00:00Z"));
		fetchMock
			.mockResolvedValueOnce(response([row(1)]))
			.mockResolvedValueOnce(response([]))
			.mockImplementation(async () => response([row(2)]));
		await render();
		expect(button("Trending")?.getAttribute("aria-pressed")).toBe("true");
		expect(titles()).toEqual(["Paper 1"]);
		expect(queryParams().get("sort")).toBe("trending");

		await click("Daily");
		expect(queryParams(1).get("date")).toBe("2026-11-22");
		expect(queryParams(2).get("date")).toBe("2026-11-21");
		expect(
			view.container.querySelector<HTMLInputElement>('input[type="date"]')
				?.value,
		).toBe("2026-11-21");
		await click("Next edition");
		expect(queryParams(3).get("date")).toBe("2026-11-22");
		expect(button("Next edition")?.disabled).toBe(true);

		await click("Weekly");
		expect(queryParams(4).get("week")).toBe("2026-W47");
		await click("Previous edition");
		expect(queryParams(5).get("week")).toBe("2026-W46");
		await click("2026-W46");
		expect(queryParams(6).get("week")).toBe("2026-W47");

		await click("Monthly");
		expect(queryParams(7).get("month")).toBe("2026-11");
		expect(readHuggingFacePrefs().mode).toBe("monthly");
	});

	it("restores a cleared daily date on blur without fetching", async () => {
		const input = await renderDailyDateInput();
		await editDate(input, "");
		expect(input.value).toBe("");
		await act(() => input.blur());
		expect(input.value).toBe("2026-11-24");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("keeps an intermediate year as a draft without fetching", async () => {
		const input = await renderDailyDateInput();
		await editDate(input, "0020-11-24");
		expect(input.value).toBe("0020-11-24");
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("requests a manually selected date without falling back from an empty edition", async () => {
		const input = await renderDailyDateInput();
		fetchMock.mockImplementation(async () => response([]));
		await editDate(input, "2026-11-23");
		await act(() => input.blur());
		expect(input.value).toBe("2026-11-23");
		expect(queryParams(1).get("date")).toBe("2026-11-23");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(titles()).toEqual([]);
	});

	it("disables previous-day navigation at the earliest supported daily date", async () => {
		const input = await renderDailyDateInput();
		fetchMock.mockImplementation(async () => response([]));
		await editDate(input, "2023-01-01");
		await act(async () => input.blur());
		expect(queryParams(1).get("date")).toBe("2023-01-01");
		expect(button("Previous edition")?.disabled).toBe(true);
		expect(button("Previous day")?.disabled).toBe(true);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("appends unique papers in feed order and stops if a full page adds none", async () => {
		const first = row(1);
		const second = row(2);
		fetchMock
			.mockResolvedValueOnce(response(Array(50).fill(first)))
			.mockResolvedValueOnce(response([first, ...Array(49).fill(second)]))
			.mockResolvedValueOnce(response(Array(50).fill(second)));
		await render();
		expect(titles()).toEqual(["Paper 1"]);
		await click("Load more");
		expect(queryParams(1).get("p")).toBe("1");
		expect(titles()).toEqual(["Paper 1", "Paper 2"]);
		await click("Load more");
		expect(queryParams(2).get("p")).toBe("2");
		expect(titles()).toEqual(["Paper 1", "Paper 2"]);
		expect(loadMore()).toBeUndefined();
	});

	it("offers one load-more button alongside clear filters when the current page has no matches", async () => {
		const nextPage = deferred<Response>();
		fetchMock
			.mockResolvedValueOnce(response(Array(50).fill(row(1))))
			.mockReturnValueOnce(nextPage.promise);
		await render();
		await click("Papers with GitHub repositories");
		expect(titles()).toEqual([]);
		expect(
			button("Clear filters")?.parentElement?.parentElement?.textContent,
		).toContain("No papers match your filters.");
		expect(loadMore()?.parentElement).toBe(
			button("Clear filters")?.parentElement,
		);
		expect(
			Array.from(view.container.querySelectorAll("button")).filter(
				(element) => element.textContent === "Load more",
			),
		).toHaveLength(1);

		await click("Load more");
		expect(queryParams(1).get("p")).toBe("1");
		expect(loadMore()?.disabled).toBe(true);
		await act(async () => {
			nextPage.resolve(
				response([row(2, { githubRepo: "https://github.com/org/repo" })]),
			);
		});
		expect(titles()).toEqual(["Paper 2"]);
		expect(button("Clear filters")).toBeUndefined();
	});

	it("shows a toast for a load-more failure and retries the same page", async () => {
		fetchMock
			.mockResolvedValueOnce(response(Array(50).fill(row(1))))
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(response([row(2)]));
		await render();
		await click("Load more");
		expect(notifyError).toHaveBeenCalledWith("HTTP 503");
		expect(titles()).toEqual(["Paper 1"]);
		expect(loadMore()?.disabled).toBe(false);
		await click("Load more");
		expect(queryParams(2).get("p")).toBe("1");
		expect(titles()).toEqual(["Paper 1", "Paper 2"]);
	});

	it("drops a pending append when the edition changes", async () => {
		let finishAppend!: (value: Response) => void;
		fetchMock
			.mockResolvedValueOnce(response(Array(50).fill(row(1))))
			.mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						finishAppend = resolve;
					}),
			)
			.mockResolvedValueOnce(response([row(3)]));
		await render();
		await click("Load more");
		expect(loadMore()?.disabled).toBe(true);
		await click("Weekly");
		expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(true);
		await act(async () => finishAppend(response([row(2)])));
		expect(titles()).toEqual(["Paper 3"]);
		expect(notifyError).not.toHaveBeenCalled();
	});

	it("toggles the keyword filter and opens a paper in the workspace", async () => {
		fetchMock.mockResolvedValueOnce(
			response([
				row(1, { ai_keywords: ["Vision"], ai_summary: "A summary" }),
				row(2, { ai_keywords: ["Language"] }),
			]),
		);
		await render();
		await click("Vision");
		expect(titles()).toEqual(["Paper 1"]);
		expect(button("Vision")?.getAttribute("aria-pressed")).toBe("true");
		await click("Read");
		expect(openRemoteArxivPaper).toHaveBeenCalledWith({
			arxivId: "2611.00001",
			title: "Paper 1",
			abstract: "A summary",
			url: "https://arxiv.org/abs/2611.00001",
		});
		await click("Vision");
		expect(titles()).toEqual(["Paper 1", "Paper 2"]);
	});

	it("shows the AI summary, expands the full abstract and translates the full text", async () => {
		fetchMock.mockResolvedValueOnce(
			response([
				row(1, {
					ai_summary: "Short summary",
					summary: "Full text",
					publishedAt: "2026-11-19T00:00:00Z",
				}),
			]),
		);
		vi.mocked(runTranslate).mockResolvedValueOnce("Translated abstract");
		await render();
		const text = () =>
			view.container.querySelector("[data-summary]")?.textContent;
		expect(view.container.querySelector("time")?.dateTime).toBe("2026-11-19");
		expect(text()).toBe("Short summary");
		await click("Full abstract");
		expect(text()).toBe("Full text");
		await click("Translate abstract");
		expect(runTranslate).toHaveBeenCalledWith(
			expect.objectContaining({ text: "Full text" }),
		);
		expect(text()).toBe("Translated abstract");
		await click("Show original abstract");
		expect(text()).toBe("Full text");
		await click("Collapse abstract");
		expect(text()).toBe("Short summary");
	});

	it("caches a pending translation without reopening a collapsed abstract", async () => {
		const translation = deferred<string>();
		vi.mocked(runTranslate).mockReturnValueOnce(translation.promise);
		fetchMock.mockImplementation(async () =>
			response([row(1, { ai_summary: "Short summary", summary: "Full text" })]),
		);
		await view.render(
			createElement(
				StrictMode,
				null,
				createElement(
					TooltipProvider,
					null,
					createElement(PlazaHuggingFaceView),
				),
			),
		);
		await click("Full abstract");
		await click("Translate abstract");
		await click("Collapse abstract");
		await act(async () => {
			translation.resolve("Translated abstract");
		});

		const text = () =>
			view.container.querySelector("[data-summary]")?.textContent;
		expect(button("Full abstract")?.getAttribute("aria-expanded")).toBe(
			"false",
		);
		expect(text()).toBe("Short summary");
		await click("Show translation");
		expect(text()).toBe("Translated abstract");
		expect(runTranslate).toHaveBeenCalledTimes(1);
	});

	it("suppresses translation errors after the card unmounts", async () => {
		const translation = deferred<string>();
		vi.mocked(runTranslate).mockReturnValueOnce(translation.promise);
		fetchMock.mockResolvedValueOnce(
			response([row(1, { summary: "Full text" })]),
		);
		await render();
		await click("Translate abstract");
		await click("Papers with GitHub repositories");
		expect(titles()).toEqual([]);
		await act(async () => {
			translation.reject(new Error("Translation failed"));
		});
		expect(notifyError).not.toHaveBeenCalled();
	});

	it("displays the edition and labels the distinct publication date in a tooltip", async () => {
		fetchMock.mockResolvedValueOnce(
			response([
				row(1, {
					submittedOnDailyAt: "2026-11-23T05:12:00Z",
					publishedAt: "2026-11-20T00:00:00Z",
				}),
			]),
		);
		await render();
		const date = view.container.querySelector("time");
		expect(date?.dateTime).toBe("2026-11-23");
		expect(date?.textContent).toBe("2026-11-23");
		const trigger = date?.closest<HTMLElement>('[data-slot="tooltip-trigger"]');
		if (!trigger) throw new Error("Missing publication date tooltip trigger");
		await act(() => trigger.focus());
		const tooltip = document.getElementById(
			trigger.getAttribute("aria-describedby") ?? "",
		);
		expect(tooltip?.getAttribute("role")).toBe("tooltip");
		expect(tooltip?.textContent).toBe("Published 2026-11-20");
	});

	it("caps collapsed keyword badges to one row and reveals full tags on expand", async () => {
		fetchMock.mockResolvedValueOnce(
			response([
				row(1, {
					summary: "Full abstract text",
					ai_keywords: ["Vision", "Robotics", "Planning", "Diffusion"],
					projectPage: "https://project.example/demo",
				}),
			]),
		);
		await render();
		expect(button("Vision")).toBeDefined();
		expect(button("Robotics")).toBeDefined();
		expect(button("Planning")).toBeUndefined();
		expect(view.container.textContent).toContain("+2");
		expect(button("Open on Hugging Face")).toBeDefined();
		expect(button("Open project page")).toBeDefined();

		await click("Full abstract");
		expect(button("Planning")).toBeDefined();
		expect(button("Diffusion")).toBeDefined();
	});
});
