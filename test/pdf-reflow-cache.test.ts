import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { preservedLayoutRegions } from "@/lib/pdf/layout/translation-exclusions";
import type {
	LayoutTranslateItem,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";
import {
	createReflowIrCache,
	decodeReflowIrCachePage,
	encodeReflowIrCachePage,
	REFLOW_IR_ALGORITHM_VERSION,
	REFLOW_IR_CACHE_FORMAT,
	REFLOW_IR_CACHE_FORMAT_VERSION,
	type ReflowIrCacheStore,
	type ReflowIrPageHeader,
} from "@/lib/pdf/reflow/cache";
import {
	clearReflowCaches,
	reflowCacheUsage,
} from "@/lib/pdf/reflow/cache-manage";
import { prepareReflowItems } from "@/lib/pdf/reflow/service";
import {
	type Box,
	type Character,
	type CharacterStyle,
	REFLOW_IR_SCHEMA_VERSION,
	type ReflowPage,
} from "@/lib/pdf/reflow/types";

vi.mock("@/lib/core/logger", () => ({
	logOp: (_name: string, _fields: unknown, run: () => Promise<unknown>) =>
		run(),
	logger: {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

const disk = vi.hoisted(() => ({
	files: new Map<string, Uint8Array>(),
	layout: "layout-one",
	failWrite: false,
	failRename: false,
}));

// Directory tree with byte sizes for the cache-manage walk (merged from
// pdf-reflow-cache-manage); `disk` above holds real IR payload bytes.
const tree = vi.hoisted(() => ({
	files: new Map<string, number>(),
	dirs: new Set<string>(),
	tauri: true,
}));

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => tree.tauri !== false }));
vi.mock("@tauri-apps/api/path", () => ({
	appCacheDir: async () => "/app-cache",
	join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
	mkdir: async () => {},
	readFile: async (path: string) => {
		const bytes = disk.files.get(path);
		if (!bytes) throw new Error(`missing ${path}`);
		return bytes;
	},
	writeFile: async (path: string, bytes: Uint8Array) => {
		if (disk.failWrite) throw new Error("write failed");
		disk.files.set(path, new Uint8Array(bytes));
	},
	rename: async (from: string, to: string) => {
		if (disk.failRename) throw new Error("rename failed");
		const bytes = disk.files.get(from);
		if (!bytes) throw new Error(`missing ${from}`);
		disk.files.set(to, bytes);
		disk.files.delete(from);
	},
	remove: async (path: string) => {
		disk.files.delete(path);
		for (const key of [...disk.files.keys()])
			if (key.startsWith(`${path}/`)) disk.files.delete(key);
		for (const key of [...tree.files.keys()])
			if (key === path || key.startsWith(`${path}/`)) tree.files.delete(key);
		for (const key of [...tree.dirs])
			if (key === path || key.startsWith(`${path}/`)) tree.dirs.delete(key);
	},
	readDir: async (dir: string) => {
		const prefix = `${dir}/`;
		const seen = new Set<string>();
		const entries: {
			name: string;
			isFile: boolean;
			isDirectory: boolean;
			isSymlink: boolean;
		}[] = [];
		for (const key of [
			...tree.dirs,
			...tree.files.keys(),
			...disk.files.keys(),
		]) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			const name = rest.split("/")[0];
			if (!name || seen.has(name)) continue;
			seen.add(name);
			const full = `${prefix}${name}`;
			entries.push({
				name,
				isFile: tree.files.has(full) || disk.files.has(full),
				isDirectory: tree.dirs.has(full),
				isSymlink: false,
			});
		}
		return entries;
	},
	stat: async (path: string) => ({
		isFile: true,
		isDirectory: tree.dirs.has(path),
		isSymlink: false,
		size: tree.files.get(path) ?? disk.files.get(path)?.byteLength ?? 0,
		mtime: new Date(0),
	}),
}));
vi.mock("@/lib/vault/fs", () => ({
	readVaultBytes: async () => new TextEncoder().encode(disk.layout),
}));
vi.mock("@/lib/pdf/layout/io", () => ({
	layoutSidecarPath: (paper: string) => `${paper}/source/layout.json`,
}));

const style: CharacterStyle = {
	font: "Times",
	size: 10,
	bold: false,
	italic: false,
	color: { r: 0, g: 0, b: 0 },
};

const box = (x: number, y: number, w: number, h: number): Box => ({
	x,
	y,
	w,
	h,
});

function header(pageIndex: number): ReflowIrPageHeader {
	return {
		format: REFLOW_IR_CACHE_FORMAT,
		formatVersion: REFLOW_IR_CACHE_FORMAT_VERSION,
		schemaVersion: REFLOW_IR_SCHEMA_VERSION,
		algorithmVersion: REFLOW_IR_ALGORITHM_VERSION,
		key: `test-key-${pageIndex}`,
		paperKey: "papers/demo",
		pdfSha256: "a".repeat(64),
		pageIndex,
		itemsSha256: "c".repeat(64),
		regionsSha256: "d".repeat(64),
	};
}

function character(index: number, text: string, x: number): Character {
	return {
		index,
		text,
		box: box(x, 10, 5, 10),
		visualBox: box(x, 12, 5, 7),
		style,
		clipBoxes: [[0, 0, 1, 1]],
		renderMode: 0,
		textAngle: 0,
		textMatrix: [1, 0, 0, 1, 10, 20],
		textObjectId: 7,
	};
}

function pageWithFormula(index: number): ReflowPage {
	return {
		index,
		width: 200,
		height: 300,
		paragraphs: [
			{
				id: `p${index}`,
				pageIndex: index,
				box: box(10, 10, 120, 30),
				characters: [
					character(0, "x", 10),
					character(1, "2", 15),
					character(2, " ", 20),
				],
				formulas: [
					{
						id: "0",
						text: "x2",
						box: box(10, 10, 10, 10),
						characterIndexes: [0, 1],
						baselineOffset: 1.5,
					},
				],
				styles: { "0": { ...style, bold: true } },
				source: `source ${index}`,
				protectedText: `source ${index} ⟪F0⟫`,
				style,
				firstLineIndent: 4,
				heading: index === 0,
				fixedBox: true,
				layoutBox: box(10, 10, 150, 30),
				origin: "table",
			},
		],
		obstacles: [box(0, 0, 10, 10)],
		coverage: [
			{ index: 0, text: "x", disposition: "formula", paragraphId: `p${index}` },
			{ index: 1, text: "2", disposition: "translated" },
			{ index: 2, text: " ", disposition: "nonpainting" },
		],
	};
}

function item(id: string, pageIndex: number): LayoutTranslateItem {
	return {
		id,
		pageIndex,
		kind: "text",
		readingOrder: 0,
		source: `source ${pageIndex} ⟪F0⟫`,
		bbox: { x: 0.05, y: 0.03, w: 0.6, h: 0.1 },
		status: "pending",
	};
}

function layoutRegion(
	overrides: Partial<PdfLayoutRegion> &
		Pick<PdfLayoutRegion, "id" | "pageIndex">,
): PdfLayoutRegion {
	return {
		kind: "text",
		label: "text",
		score: 1,
		readingOrder: 0,
		rect: { x: 10, y: 100, w: 120, h: 20 },
		bbox: { x: 0.05, y: 0.3, w: 0.6, h: 0.05 },
		...overrides,
	};
}

function cacheSource(
	items: readonly LayoutTranslateItem[],
	regions: readonly PdfLayoutRegion[],
	pdf = "pdf-one",
) {
	return {
		paperKey: "papers/demo",
		paperAbsPath: "/vault/papers/demo",
		pdfBytes: new TextEncoder().encode(pdf),
		items,
		regions,
	};
}

function irFiles(): string[] {
	return [...disk.files.keys()]
		.filter((path) => path.endsWith(".json.gz"))
		.sort();
}

const document = {
	pages: [0, 1].map((index) => ({
		index,
		size: { width: 200, height: 300 },
	})),
} as unknown as PdfDocumentObject;

describe("reflow IR cache", () => {
	beforeEach(() => {
		disk.files.clear();
		disk.layout = "layout-one";
		disk.failWrite = false;
		disk.failRename = false;
	});

	it("roundtrips a page with formulas, styles, table fields, and coverage", async () => {
		const page = pageWithFormula(0);
		const expected = header(0);
		const bytes = await encodeReflowIrCachePage({ ...expected, page });
		const decoded = await decodeReflowIrCachePage(bytes, expected);
		expect(decoded).toEqual(page);
		expect(decoded?.paragraphs[0].formulas[0]).toEqual({
			id: "0",
			text: "x2",
			box: box(10, 10, 10, 10),
			characterIndexes: [0, 1],
			baselineOffset: 1.5,
		});
		expect(decoded?.paragraphs[0].characters[0]).toMatchObject({
			clipBoxes: [[0, 0, 1, 1]],
			renderMode: 0,
			textAngle: 0,
			textMatrix: [1, 0, 0, 1, 10, 20],
			textObjectId: 7,
		});
		expect(decoded?.paragraphs[0].origin).toBe("table");
		expect(decoded?.coverage?.[0].disposition).toBe("formula");
	});

	it("roundtrips pages independently so cross-page runs can merge them", async () => {
		const first = pageWithFormula(0);
		const second = pageWithFormula(1);
		const firstHeader = header(0);
		const secondHeader = header(1);
		const [firstBytes, secondBytes] = await Promise.all([
			encodeReflowIrCachePage({ ...firstHeader, page: first }),
			encodeReflowIrCachePage({ ...secondHeader, page: second }),
		]);
		const [decodedFirst, decodedSecond] = await Promise.all([
			decodeReflowIrCachePage(firstBytes, firstHeader),
			decodeReflowIrCachePage(secondBytes, secondHeader),
		]);
		expect(decodedFirst?.index).toBe(0);
		expect(decodedSecond?.index).toBe(1);
		expect(decodedSecond?.paragraphs[0].heading).toBe(false);
		expect(decodedSecond?.paragraphs[0].formulas[0].text).toBe("x2");
	});

	it("skips PDFium extraction when every requested page is cached", async () => {
		const read = vi.fn(
			async (pageIndexes: readonly number[]) =>
				new Map(pageIndexes.map((index) => [index, pageWithFormula(index)])),
		);
		const write = vi.fn(async () => {});
		const cache: ReflowIrCacheStore = { read, write };
		const engine = {
			getPageGlyphs: vi.fn(() => {
				throw new Error("extraction must not run on a cache hit");
			}),
		} as unknown as PdfEngine;
		const prepared = await prepareReflowItems(
			engine,
			document,
			[item("p0", 0), item("p1", 1)],
			[],
			undefined,
			cache,
		);
		expect(read).toHaveBeenCalledWith([0, 1]);
		expect(engine.getPageGlyphs).not.toHaveBeenCalled();
		expect(write).not.toHaveBeenCalled();
		expect(prepared.filter((entry) => entry.reflow)).toHaveLength(2);
	});

	it("falls back to extraction when the cached page is rejected", async () => {
		const cache: ReflowIrCacheStore = {
			read: vi.fn(async () => new Map()),
			write: vi.fn(async () => {}),
		};
		const getPageGlyphs = vi.fn(() => ({ toPromise: async () => [] }));
		const engine = {
			getPageGlyphs,
			getPageTextRuns: vi.fn(() => ({ toPromise: async () => ({ runs: [] }) })),
			getTextSlices: vi.fn(() => ({ toPromise: async () => [] })),
			renderPageRaw: vi.fn(() => ({
				toPromise: async () => ({
					width: 1,
					height: 1,
					data: new Uint8ClampedArray(4),
				}),
			})),
		} as unknown as PdfEngine;
		await prepareReflowItems(
			engine,
			document,
			[item("p0", 0)],
			[],
			undefined,
			cache,
		);
		expect(getPageGlyphs).toHaveBeenCalledTimes(1);
		expect(cache.write).toHaveBeenCalledTimes(1);
	});

	it("does not restore bibliography paragraphs or their fallback blocks from cached IR", async () => {
		const page = pageWithFormula(0);
		const reference = {
			...page.paragraphs[0],
			id: "reference",
			box: box(10, 100, 120, 30),
		};
		page.paragraphs.push(reference, {
			...reference,
			id: "0:fallback:100",
			box: box(15, 110, 40, 10),
			origin: "fallback",
		});
		const region: PdfLayoutRegion = {
			id: reference.id,
			pageIndex: 0,
			kind: "text",
			label: "reference",
			score: 1,
			readingOrder: 1,
			rect: reference.box,
			bbox: { x: 0.05, y: 1 / 3, w: 0.6, h: 0.1 },
		};
		const engine = {
			getPageGlyphs: vi.fn(() => {
				throw new Error("extraction must not run on a cache hit");
			}),
		} as unknown as PdfEngine;
		const prepared = await prepareReflowItems(
			engine,
			document,
			[item("p0", 0)],
			[region],
			undefined,
			{
				read: async () => new Map([[0, page]]),
				write: vi.fn(),
			},
		);
		expect(prepared.map((entry) => entry.id)).toEqual(["p0"]);
		expect(engine.getPageGlyphs).not.toHaveBeenCalled();
	});

	it("persists pages through the real store and misses when the PDF changes", async () => {
		const source = cacheSource([item("p0", 0)], []);
		const cache = createReflowIrCache(source);
		expect(await cache.read([0])).toEqual(new Map());
		const page = pageWithFormula(0);
		await cache.write([page]);
		expect(await cache.read([0])).toEqual(new Map([[0, page]]));

		const otherPdf = createReflowIrCache({
			...source,
			pdfBytes: new TextEncoder().encode("pdf-two"),
		});
		expect(await otherPdf.read([0])).toEqual(new Map());
		expect(irFiles()).toHaveLength(1);
	});

	it("reuses the page file when sidecar bytes or unused fields change", async () => {
		disk.layout = JSON.stringify({
			generatedAt: "2026-01-01T00:00:00.000Z",
			regions: [{ id: "r0" }],
		});
		const regions = [
			layoutRegion({
				id: "r0",
				pageIndex: 0,
				text: "Introduction",
				title: "Introduction",
				sourceStyle: { fontSize: 0.02, bold: false, italic: false },
				titleBbox: { x: 0.1, y: 0.1, w: 0.2, h: 0.05 },
				captionBbox: { x: 0.1, y: 0.2, w: 0.2, h: 0.04 },
			}),
		];
		const page = pageWithFormula(0);
		await createReflowIrCache(cacheSource([item("p0", 0)], regions)).write([
			page,
		]);
		const files = irFiles();
		expect(files).toHaveLength(1);

		disk.layout = `{
			"generatedAt": "2026-11-21T08:00:00.000Z",
			"regions": [{ "id": "r0" }]
		}`;
		const again = createReflowIrCache(
			cacheSource(
				[
					{
						...item("p0", 0),
						source: "changed source",
						translated: "译文",
						status: "done",
					},
				],
				[
					layoutRegion({
						id: "r0",
						pageIndex: 0,
						text: "Introduction",
						title: "Introduction",
						sourceStyle: { fontSize: 0.02, bold: true, italic: true },
						titleBbox: { x: 0.4, y: 0.4, w: 0.1, h: 0.1 },
						captionBbox: { x: 0.5, y: 0.5, w: 0.1, h: 0.1 },
						captionPageIndex: 3,
					}),
				],
			),
		);
		expect(await again.read([0])).toEqual(new Map([[0, page]]));
		await again.write([page]);
		expect(irFiles()).toEqual(files);
	});

	it("misses when the page box, kind, reading order, or PDF bytes change", async () => {
		const regions = [layoutRegion({ id: "r0", pageIndex: 0, text: "Body" })];
		const items = [item("p0", 0)];
		const page = pageWithFormula(0);
		await createReflowIrCache(cacheSource(items, regions)).write([page]);
		const files = irFiles();

		const moved = createReflowIrCache(
			cacheSource(
				[{ ...items[0], bbox: { x: 0.2, y: 0.2, w: 0.2, h: 0.2 } }],
				regions,
			),
		);
		expect(await moved.read([0])).toEqual(new Map());

		const resized = createReflowIrCache(
			cacheSource(items, [
				layoutRegion({
					id: "r0",
					pageIndex: 0,
					text: "Body",
					rect: { x: 12, y: 40, w: 80, h: 30 },
				}),
			]),
		);
		expect(await resized.read([0])).toEqual(new Map());

		const headed = createReflowIrCache(
			cacheSource([{ ...items[0], kind: "header" }], regions),
		);
		expect(await headed.read([0])).toEqual(new Map());

		const formula = createReflowIrCache(
			cacheSource(items, [
				layoutRegion({
					id: "r0",
					pageIndex: 0,
					text: "Body",
					kind: "formula",
					label: "formula",
				}),
			]),
		);
		expect(await formula.read([0])).toEqual(new Map());

		const reordered = createReflowIrCache(
			cacheSource([{ ...items[0], readingOrder: 4 }], regions),
		);
		expect(await reordered.read([0])).toEqual(new Map());

		const otherPdf = createReflowIrCache(
			cacheSource(items, regions, "pdf-two"),
		);
		expect(await otherPdf.read([0])).toEqual(new Map());
		expect(irFiles()).toEqual(files);
	});

	it("misses only the page whose text changes preservation", async () => {
		const body = layoutRegion({
			id: "body",
			pageIndex: 1,
			text: "Unchanged body",
		});
		const intro = layoutRegion({
			id: "h0",
			pageIndex: 0,
			kind: "header",
			label: "paragraph_title",
			text: "Introduction",
		});
		const references = { ...intro, text: "References" };
		expect(preservedLayoutRegions([intro, body]).has("h0")).toBe(false);
		expect(preservedLayoutRegions([references, body]).get("h0")).toBe(
			"reference",
		);

		const items = [item("p0", 0), item("p1", 1)];
		const page0 = pageWithFormula(0);
		const page1 = pageWithFormula(1);
		await createReflowIrCache(cacheSource(items, [intro, body])).write([
			page0,
			page1,
		]);
		const next = createReflowIrCache(cacheSource(items, [references, body]));
		expect(await next.read([0])).toEqual(new Map());
		expect(await next.read([1])).toEqual(new Map([[1, page1]]));

		const titleIntro = { ...intro, text: undefined, title: "Introduction" };
		const titleOnly = { ...intro, text: undefined, title: "References" };
		expect(preservedLayoutRegions([titleIntro, body]).has("h0")).toBe(false);
		expect(preservedLayoutRegions([titleOnly, body]).get("h0")).toBe(
			"reference",
		);
		disk.files.clear();
		await createReflowIrCache(cacheSource(items, [titleIntro, body])).write([
			page0,
			page1,
		]);
		const titled = createReflowIrCache(cacheSource(items, [titleOnly, body]));
		expect(await titled.read([0])).toEqual(new Map());
		expect(await titled.read([1])).toEqual(new Map([[1, page1]]));

		const plain = layoutRegion({
			id: "run",
			pageIndex: 0,
			kind: "header",
			label: "header",
			text: "Introduction",
			bbox: { x: 0.05, y: 0.02, w: 0.4, h: 0.03 },
		});
		const running = { ...plain, text: "Journal of Physics" };
		const caption = { ...running, captionRole: "figure_main" as const };
		expect(preservedLayoutRegions([plain, body]).has("run")).toBe(false);
		expect(preservedLayoutRegions([running, body]).get("run")).toBe(
			"page-header",
		);
		expect(preservedLayoutRegions([caption, body]).has("run")).toBe(false);

		disk.files.clear();
		await createReflowIrCache(cacheSource(items, [plain, body])).write([
			page0,
			page1,
		]);
		const shifted = createReflowIrCache(cacheSource(items, [running, body]));
		expect(await shifted.read([0])).toEqual(new Map());
		expect(await shifted.read([1])).toEqual(new Map([[1, page1]]));
		const captioned = createReflowIrCache(cacheSource(items, [caption, body]));
		await createReflowIrCache(cacheSource(items, [running, body])).write([
			page0,
			page1,
		]);
		expect(await captioned.read([0])).toEqual(new Map());
		expect(await captioned.read([1])).toEqual(new Map([[1, page1]]));

		const title = layoutRegion({
			id: "title",
			pageIndex: 0,
			kind: "header",
			label: "paragraph_title",
			text: "A Study of Widgets",
			bbox: { x: 0.1, y: 0.05, w: 0.8, h: 0.06 },
			sourceStyle: { fontSize: 0.04, bold: true, italic: false },
		});
		const prose = layoutRegion({
			id: "prose",
			pageIndex: 0,
			kind: "text",
			label: "text",
			text: "Ordinary prose without an abstract heading.",
			bbox: { x: 0.1, y: 0.4, w: 0.8, h: 0.1 },
			sourceStyle: { fontSize: 0.02, bold: false, italic: false },
		});
		const smallTitle = {
			...title,
			sourceStyle: { fontSize: 0.02, bold: true, italic: false },
		};
		expect(preservedLayoutRegions([title, prose, body]).get("title")).toBe(
			"paper-title",
		);
		expect(preservedLayoutRegions([smallTitle, prose, body]).has("title")).toBe(
			false,
		);
		disk.files.clear();
		await createReflowIrCache(
			cacheSource(items, [smallTitle, prose, body]),
		).write([page0, page1]);
		const larger = createReflowIrCache(
			cacheSource(items, [title, prose, body]),
		);
		expect(await larger.read([0])).toEqual(new Map());
		expect(await larger.read([1])).toEqual(new Map([[1, page1]]));
	});

	it("drops same-page files only after the new page file is renamed into place", async () => {
		const intro = layoutRegion({
			id: "h0",
			pageIndex: 0,
			kind: "header",
			label: "paragraph_title",
			text: "Introduction",
		});
		const references = { ...intro, text: "References" };
		const body = layoutRegion({
			id: "body",
			pageIndex: 1,
			text: "Unchanged body",
		});
		const items = [item("p0", 0), item("p1", 1)];
		const page0 = pageWithFormula(0);
		const page1 = pageWithFormula(1);
		await createReflowIrCache(cacheSource(items, [intro, body])).write([
			page0,
			page1,
		]);
		const before = irFiles();
		expect(before).toHaveLength(2);
		const page0File = before.find((path) => path.includes("/0-"));
		const page1File = before.find((path) => path.includes("/1-"));
		if (!page0File || !page1File) throw new Error("missing page files");
		const dir = page0File.slice(0, page0File.lastIndexOf("/"));
		const seeded = `${dir}/0-aaaaaaaaaaaaaaaaaaaa.json.gz`;
		const otherPage = `${dir}/10-bbbbbbbbbbbbbbbbbbbb.json.gz`;
		disk.files.set(seeded, new Uint8Array([1, 2, 3]));
		disk.files.set(otherPage, new Uint8Array([4]));

		const replaced = pageWithFormula(0);
		replaced.paragraphs[0].source = "replaced";
		await createReflowIrCache(cacheSource(items, [references, body])).write([
			replaced,
		]);

		const after = irFiles();
		expect(after).not.toContain(page0File);
		expect(after).not.toContain(seeded);
		expect(after).toContain(page1File);
		expect(after).toContain(otherPage);
		expect(after.filter((path) => path.includes("/0-"))).toHaveLength(1);
		const read = await createReflowIrCache(
			cacheSource(items, [references, body]),
		).read([0, 1]);
		expect(read.get(0)?.paragraphs[0].source).toBe("replaced");
		expect(read.get(1)).toEqual(page1);
	});

	it("keeps the previous page file when the write or rename fails", async () => {
		const intro = layoutRegion({
			id: "h0",
			pageIndex: 0,
			kind: "header",
			label: "paragraph_title",
			text: "Introduction",
		});
		const references = { ...intro, text: "References" };
		const items = [item("p0", 0)];
		const page = pageWithFormula(0);
		await createReflowIrCache(cacheSource(items, [intro])).write([page]);
		const before = irFiles();
		expect(before).toHaveLength(1);
		const bytes = disk.files.get(before[0] ?? "");

		disk.failWrite = true;
		await createReflowIrCache(cacheSource(items, [references])).write([
			pageWithFormula(0),
		]);
		expect(irFiles()).toEqual(before);
		expect(disk.files.get(before[0] ?? "")).toBe(bytes);
		expect([...disk.files.keys()].some((path) => path.includes(".tmp"))).toBe(
			false,
		);

		disk.failWrite = false;
		disk.failRename = true;
		await createReflowIrCache(cacheSource(items, [references])).write([
			pageWithFormula(0),
		]);
		expect(irFiles()).toEqual(before);
		expect(disk.files.get(before[0] ?? "")).toBe(bytes);
		expect([...disk.files.keys()].some((path) => path.includes(".tmp"))).toBe(
			false,
		);

		disk.failRename = false;
		await createReflowIrCache(cacheSource(items, [references])).write([
			pageWithFormula(0),
		]);
		expect(irFiles()).toHaveLength(1);
		expect(irFiles()).not.toEqual(before);
	});

	it("stops writing new pages when persistence is disabled but keeps reusing existing ones", async () => {
		disk.files.clear();
		let enabled = true;
		const cache = createReflowIrCache(
			{
				paperKey: "papers/demo",
				paperAbsPath: "/vault/papers/demo",
				pdfBytes: new TextEncoder().encode("pdf-one"),
				items: [item("p0", 0), item("p1", 1)],
				regions: [],
			},
			{ writesEnabled: () => enabled },
		);
		await cache.write([pageWithFormula(0)]);
		expect(disk.files.size).toBe(1);

		enabled = false;
		await cache.write([pageWithFormula(1)]);
		expect(disk.files.size).toBe(1);
		expect(await cache.read([0])).toEqual(new Map([[0, pageWithFormula(0)]]));
		expect(await cache.read([1])).toEqual(new Map());
	});

	it("rejects corrupt payloads, different keys, and older versions", async () => {
		const page = pageWithFormula(0);
		const expected = header(0);
		const bytes = await encodeReflowIrCachePage({ ...expected, page });
		expect(await decodeReflowIrCachePage(bytes, expected)).toEqual(page);
		expect(
			await decodeReflowIrCachePage(bytes, {
				...expected,
				key: "another-key",
			}),
		).toBeNull();
		expect(
			await decodeReflowIrCachePage(bytes, {
				...expected,
				algorithmVersion: REFLOW_IR_ALGORITHM_VERSION + 1,
			}),
		).toBeNull();
		expect(
			await decodeReflowIrCachePage(bytes, {
				...expected,
				formatVersion: REFLOW_IR_CACHE_FORMAT_VERSION + 1,
			}),
		).toBeNull();
		expect(
			await decodeReflowIrCachePage(
				new TextEncoder().encode("not json"),
				expected,
			),
		).toBeNull();
		expect(
			await decodeReflowIrCachePage(
				new Uint8Array([0x1f, 0x8b, 0x08, 0x00, 0x00]),
				expected,
			),
		).toBeNull();

		const broken = JSON.parse(
			new TextDecoder().decode(
				await new Response(
					new Blob([bytes])
						.stream()
						.pipeThrough(new DecompressionStream("gzip")),
				).arrayBuffer(),
			),
		);
		broken.page.paragraphs[0].box = { x: 1 };
		const brokenBytes = await encodeRaw(broken);
		expect(await decodeReflowIrCachePage(brokenBytes, expected)).toBeNull();

		const wrongPage = JSON.parse(
			new TextDecoder().decode(
				await new Response(
					new Blob([bytes])
						.stream()
						.pipeThrough(new DecompressionStream("gzip")),
				).arrayBuffer(),
			),
		);
		wrongPage.page.index += 1;
		expect(
			await decodeReflowIrCachePage(await encodeRaw(wrongPage), expected),
		).toBeNull();
	});
});

async function encodeRaw(value: unknown): Promise<Uint8Array> {
	const json = new TextEncoder().encode(JSON.stringify(value));
	const stream = new Blob([json])
		.stream()
		.pipeThrough(new CompressionStream("gzip"));
	return new Uint8Array(await new Response(stream).arrayBuffer());
}

// --- cache usage and cleanup (merged from pdf-reflow-cache-manage) ---

function seed(path: string, size: number, isDir = false): void {
	tree.files.delete(path);
	tree.dirs.delete(path);
	if (isDir) tree.dirs.add(path);
	else tree.files.set(path, size);
	const parts = path.split("/");
	for (let i = 1; i < parts.length; i++)
		tree.dirs.add(parts.slice(0, i).join("/"));
	tree.dirs.delete(path);
}

describe("reflow cache usage and cleanup", () => {
	beforeEach(() => {
		disk.files.clear();
		tree.files.clear();
		tree.dirs.clear();
		tree.tauri = true;
		seed("/app-cache", 0, true);
	});

	it("sums bytes across both cache roots and counts IR papers", async () => {
		seed("/app-cache/reflow-ir/paperA-abc/0-a.json.gz", 100);
		seed("/app-cache/reflow-ir/paperA-abc/1-b.json.gz", 50);
		seed("/app-cache/reflow-ir/paperB-def/0-c.json.gz", 30);
		seed("/app-cache/reflow-build/prefixA-final-k.pdf", 1000);
		// Outside the reflow caches: must not count.
		seed("/app-cache/pdf-fonts/rev/Noto.ttf", 99999);

		const usage = await reflowCacheUsage();
		expect(usage).toEqual({ papers: 2, bytes: 1180 });
	});

	it("reports null without IR cache and zero papers with build-only files", async () => {
		expect(await reflowCacheUsage()).toEqual({ papers: 0, bytes: 0 });
		seed("/app-cache/reflow-build/prefixA-final-k.pdf", 500);
		const usage = await reflowCacheUsage();
		expect(usage?.bytes).toBe(500);
	});

	it("clears both roots, keeps fonts, and returns the freed size", async () => {
		seed("/app-cache/reflow-ir/paperA-abc/0-a.json.gz", 100);
		seed("/app-cache/reflow-build/prefixA-final-k.pdf", 1000);
		seed("/app-cache/pdf-fonts/rev/Noto.ttf", 99999);

		const freed = await clearReflowCaches();
		expect(freed).toBe(1100);
		expect(tree.files.has("/app-cache/pdf-fonts/rev/Noto.ttf")).toBe(true);
		expect(
			[...tree.files.keys()].filter((path) =>
				path.startsWith("/app-cache/reflow"),
			),
		).toEqual([]);
	});

	it("degrades safely outside Tauri", async () => {
		tree.tauri = false;
		expect(await reflowCacheUsage()).toBeNull();
		expect(await clearReflowCaches()).toBe(0);
	});
});
