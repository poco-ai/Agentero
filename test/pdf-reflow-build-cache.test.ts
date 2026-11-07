import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import type { PDFFont } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import {
	createReflowBuildCache,
	type ReflowBuildCacheStore,
} from "@/lib/pdf/reflow/build-cache";
import { paragraphFromCharacters } from "@/lib/pdf/reflow/extract";
import { ReflowPreviewSession } from "@/lib/pdf/reflow/preview";

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

const disk = vi.hoisted(() => ({ files: new Map<string, Uint8Array>() }));

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
}));

const metric = {
	widthOfTextAtSize: (text: string, size: number) =>
		Array.from(text).reduce(
			(n, c) => n + (/[\u4e00-\u9fff，。]/u.test(c) ? size : size * 0.5),
			0,
		),
	heightAtSize: (size: number) => size,
	encodeText: () => ({}),
} as unknown as PDFFont;
const embeddedFonts = {
	regular: metric,
	bold: metric,
	italic: metric,
	boldItalic: metric,
	cjk: metric,
	cjkBold: metric,
};
const fontBytes = {
	regular: new Uint8Array([1]),
	bold: new Uint8Array([2]),
	italic: new Uint8Array([3]),
	boldItalic: new Uint8Array([4]),
	cjk: new Uint8Array([5]),
	cjkBold: new Uint8Array([6]),
};

vi.mock("@/lib/pdf/reflow/fonts", () => ({
	loadReflowFonts: vi.fn(async () => fontBytes),
}));

const buildPage = vi.hoisted(() => ({
	fn: vi.fn(),
}));
vi.mock("@/lib/pdf/reflow/export", () => ({
	buildReflowPage: buildPage.fn,
	buildReflowPdf: vi.fn(),
	embedReflowFonts: vi.fn(async () => embeddedFonts),
}));

function item(
	id: string,
	pageIndex: number,
	status: LayoutTranslateItem["status"] = "done",
): LayoutTranslateItem {
	return {
		id,
		pageIndex,
		status,
		kind: "text",
		readingOrder: 0,
		source: "original",
		raw: "original",
		translated: status === "done" ? "译文" : undefined,
		bbox: { x: 0.1, y: 0.1, w: 0.8, h: 0.2 },
		reflow: paragraphFromCharacters(
			id,
			pageIndex,
			{ x: 10, y: 10, w: 80, h: 20 },
			[],
			[],
			false,
		),
	};
}

const document = {
	id: "source",
	pages: Array.from({ length: 2 }, (_, index) => ({
		index,
		size: { width: 100, height: 100 },
	})),
} as unknown as PdfDocumentObject;

const render = vi.fn(() => ({ toPromise: async () => new Blob(["preview"]) }));
const close = vi.fn(() => ({ toPromise: async () => true }));
const engine = {
	openDocumentBuffer: vi.fn(() => ({ toPromise: async () => document })),
	renderPage: render,
	closeDocument: close,
} as unknown as PdfEngine;

let session: ReflowPreviewSession;
const failed = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	disk.files.clear();
	buildPage.fn.mockReset();
	buildPage.fn.mockImplementation(async (_engine, _doc, ir, translations) => ({
		bytes: new Uint8Array([7, translations.size]),
		pages: ir.pages.map((page) => ({
			index: page.index,
			width: page.width,
			height: page.height,
			paragraphs: page.paragraphs.map((p) => ({
				id: p.id,
				pageIndex: p.pageIndex,
				sourceBox: p.box,
				box: p.box,
				scale: 1,
				units: [],
				fits: true,
			})),
		})),
	}));
	vi.spyOn(URL, "createObjectURL").mockImplementation(
		() => `blob:${crypto.randomUUID()}`,
	);
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
	session = new ReflowPreviewSession(engine, document, () => {}, failed);
});

describe("reflow build cache", () => {
	it("roundtrips final bytes and misses when translations or PDF change", async () => {
		const cache = createReflowBuildCache({
			paperKey: "papers/demo",
			pdfBytes: new TextEncoder().encode("pdf-one"),
		});
		const ir = {
			version: 1 as const,
			pages: [
				{
					index: 0,
					width: 100,
					height: 100,
					paragraphs: [],
					obstacles: [],
				},
			],
		};
		const translations = new Map([["p0", "译文"]]);
		await cache.writeFinal(
			ir,
			translations,
			fontBytes,
			new Uint8Array([1, 2, 3]),
		);
		expect(await cache.readFinal(ir, translations, fontBytes)).toEqual(
			new Uint8Array([1, 2, 3]),
		);
		expect(
			await cache.readFinal(ir, new Map([["p0", "别的译文"]]), fontBytes),
		).toBeNull();
		const otherPdf = createReflowBuildCache({
			paperKey: "papers/demo",
			pdfBytes: new TextEncoder().encode("pdf-two"),
		});
		expect(await otherPdf.readFinal(ir, translations, fontBytes)).toBeNull();
	});

	it("roundtrips page builds per page index", async () => {
		const cache = createReflowBuildCache({
			paperKey: "papers/demo",
			pdfBytes: new TextEncoder().encode("pdf-one"),
		});
		const ir = {
			version: 1 as const,
			pages: [
				{
					index: 0,
					width: 100,
					height: 100,
					paragraphs: [],
					obstacles: [],
				},
				{
					index: 1,
					width: 100,
					height: 100,
					paragraphs: [],
					obstacles: [],
				},
			],
		};
		const translations = new Map([["p0", "译文"]]);
		await cache.writePage(ir, 0, translations, fontBytes, new Uint8Array([1]));
		await cache.writePage(ir, 1, translations, fontBytes, new Uint8Array([2]));
		expect(await cache.readPage(ir, 0, translations, fontBytes)).toEqual(
			new Uint8Array([1]),
		);
		expect(await cache.readPage(ir, 1, translations, fontBytes)).toEqual(
			new Uint8Array([2]),
		);
		expect(
			await cache.readPage(ir, 1, new Map([["p0", "重译"]]), fontBytes),
		).toBeNull();
	});

	it("skips the builder on a cache hit and publishes the cached bytes", async () => {
		const cache: ReflowBuildCacheStore = {
			readPage: vi.fn(async () => new Uint8Array([9, 9])),
			writePage: vi.fn(async () => {}),
			readFinal: vi.fn(async () => null),
			writeFinal: vi.fn(async () => {}),
		};
		session = new ReflowPreviewSession(
			engine,
			document,
			() => {},
			failed,
			undefined,
			cache,
		);
		const first = item("p0", 0);
		session.update([first], [], true);
		await vi.waitFor(() => expect(session.busy).toBe(false));
		expect(buildPage.fn).not.toHaveBeenCalled();
		expect(cache.writePage).not.toHaveBeenCalled();
		expect(render).toHaveBeenCalledTimes(1);
		const decorated = session.decorate([first])[0];
		expect(decorated.reflowPreview).toBeTruthy();
		expect(decorated.reflowLayout?.id).toBe("p0");
	});

	it("persists a fresh page build for the next run", async () => {
		const cache: ReflowBuildCacheStore = {
			readPage: vi.fn(async (_d, pageIndex: number) =>
				pageIndex === 0 ? new Uint8Array([9, 9]) : null,
			),
			writePage: vi.fn(async () => {}),
			readFinal: vi.fn(async () => null),
			writeFinal: vi.fn(async () => {}),
		};
		session = new ReflowPreviewSession(
			engine,
			document,
			() => {},
			failed,
			undefined,
			cache,
		);
		session.update([item("p0", 0), item("p1", 1)], [], true);
		await vi.waitFor(() => expect(session.busy).toBe(false));
		expect(buildPage.fn).toHaveBeenCalledTimes(1);
		expect(cache.writePage).toHaveBeenCalledTimes(1);
		const call = buildPage.fn.mock.calls[0];
		expect(call[2].pages[0].index).toBe(1);
	});
});
