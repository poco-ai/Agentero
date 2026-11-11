import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { describe, expect, it, vi } from "vitest";
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
}));

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
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
		disk.files.set(path, new Uint8Array(bytes));
	},
	rename: async (from: string, to: string) => {
		const bytes = disk.files.get(from);
		if (!bytes) throw new Error(`missing ${from}`);
		disk.files.set(to, bytes);
		disk.files.delete(from);
	},
	remove: async (path: string) => {
		disk.files.delete(path);
	},
	readDir: async (dir: string) =>
		[...disk.files.keys()]
			.filter((path) => path.startsWith(`${dir}/`))
			.map((path) => ({
				name: path.slice(dir.length + 1),
				isFile: true,
				isDirectory: false,
				isSymlink: false,
			})),
	stat: async () => ({
		isFile: true,
		isDirectory: false,
		isSymlink: false,
		size: 0,
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
		layoutSha256: "b".repeat(64),
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

it("isolates reader bibliography IR from translation cache entries in both directions", async () => {
	disk.files.clear();
	const input = {
		paperKey: "papers/reference-cache",
		paperAbsPath: "/vault/papers/reference-cache",
		pdfBytes: new Uint8Array([37, 80, 68, 70]),
		items: [],
		regions: [],
	};
	const translation = createReflowIrCache(input);
	const reader = createReflowIrCache({ ...input, includeReferences: true });
	await translation.write([pageWithFormula(0)]);
	expect((await reader.read([0])).size).toBe(0);
	const retained = pageWithFormula(0);
	retained.paragraphs[0].source = "Retained bibliography";
	await reader.write([retained]);
	expect((await reader.read([0])).get(0)?.paragraphs[0].source).toBe(
		"Retained bibliography",
	);
	expect((await translation.read([0])).get(0)?.paragraphs[0].source).toBe(
		"source 0",
	);
});

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

const document = {
	pages: [0, 1].map((index) => ({
		index,
		size: { width: 200, height: 300 },
	})),
} as unknown as PdfDocumentObject;

describe("reflow IR cache", () => {
	it("invalidates the pre-migration extraction algorithm", async () => {
		const expected = header(0);
		const old = await encodeReflowIrCachePage({
			...expected,
			algorithmVersion: 1,
			page: pageWithFormula(0),
		});
		expect(await decodeReflowIrCachePage(old, expected)).toBeNull();
	});
	it("shares decoded styles across the prepared document", async () => {
		const pages = new Map<number, ReflowPage>();
		for (const index of [0, 1]) {
			const expected = header(index);
			const page = await decodeReflowIrCachePage(
				await encodeReflowIrCachePage({
					...expected,
					page: pageWithFormula(index),
				}),
				expected,
			);
			if (page) pages.set(index, page);
		}
		const prepared = await prepareReflowItems(
			{} as PdfEngine,
			document,
			[item("p0", 0), item("p1", 1)],
			[],
			undefined,
			{ read: async () => pages, write: async () => {} },
		);
		const styles = prepared.flatMap(
			(p) => p.reflow?.characters.map((c) => c.style) ?? [],
		);
		expect(new Set(styles).size).toBe(1);
		expect(prepared[0].reflow?.style).toBe(styles[0]);
	});
	it("recovers an unselected page while keeping a selected cache hit", async () => {
		const getPageGlyphs = vi.fn(() => ({ toPromise: async () => [] }));
		const engine = {
			getPageGlyphs,
			getPageTextRuns: () => ({ toPromise: async () => ({ runs: [] }) }),
			getTextSlices: () => ({ toPromise: async () => [] }),
		} as unknown as PdfEngine;
		const cache = {
			read: vi.fn(async () => new Map([[0, pageWithFormula(0)]])),
			write: vi.fn(async () => {}),
		};
		await prepareReflowItems(
			engine,
			document,
			[item("p0", 0)],
			[],
			undefined,
			cache,
			{ includeUnselectedPages: true },
		);
		expect(cache.read).toHaveBeenCalledWith([0, 1]);
		expect(getPageGlyphs).toHaveBeenCalledTimes(1);
		expect(getPageGlyphs.mock.calls[0]).toEqual([document, document.pages[1]]);
		expect(cache.write).toHaveBeenCalledWith([
			expect.objectContaining({ index: 1 }),
		]);
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

	it("persists pages through the real store and misses when PDF or layout changes", async () => {
		disk.files.clear();
		disk.layout = "layout-one";
		const source = {
			paperKey: "papers/demo",
			paperAbsPath: "/vault/papers/demo",
			pdfBytes: new TextEncoder().encode("pdf-one"),
			items: [item("p0", 0)],
			regions: [],
		};
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

		disk.layout = "layout-two";
		const otherLayout = createReflowIrCache(source);
		expect(await otherLayout.read([0])).toEqual(new Map());
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
