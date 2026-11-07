import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import type { PDFFont } from "pdf-lib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutTranslateItem } from "@/lib/pdf/layout/types";
import type { ReflowBuildCacheStore } from "@/lib/pdf/reflow/build-cache";
import { createReflowBuildCache } from "@/lib/pdf/reflow/build-cache";
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

const disk = vi.hoisted(() => ({
	files: new Map<string, Uint8Array>(),
	mtimes: new Map<string, number>(),
	tick: 0,
}));

function seedDiskFile(name: string, bytes: Uint8Array): void {
	disk.files.set(`/app-cache/reflow-build/${name}`, bytes);
	disk.mtimes.set(`/app-cache/reflow-build/${name}`, 0);
}

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
		disk.tick += 1;
		disk.mtimes.set(path, disk.tick);
	},
	remove: async (path: string) => {
		disk.files.delete(path);
		disk.mtimes.delete(path);
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
	stat: async (path: string) => ({
		isFile: true,
		isDirectory: false,
		isSymlink: false,
		size: 0,
		mtime: new Date(disk.mtimes.get(path) ?? 0),
	}),
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

const pageBuild = vi.hoisted(() => ({ fn: vi.fn() }));
const buildPdf = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock("@/lib/pdf/reflow/export", () => ({
	buildReflowPage: pageBuild.fn,
	buildReflowPdf: buildPdf.fn,
	embedReflowFonts: vi.fn(async () => embeddedFonts),
}));

function layoutsFrom(ir: {
	pages: {
		index: number;
		width: number;
		height: number;
		paragraphs: { id: string; pageIndex: number; box: unknown }[];
	}[];
}) {
	return ir.pages.map((page) => ({
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
	}));
}

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

const buildOutput = (ir: {
	pages: {
		index: number;
		width: number;
		height: number;
		paragraphs: {
			id: string;
			pageIndex: number;
			box: { x: number; y: number; w: number; h: number };
		}[];
	}[];
}) => ({ bytes: new Uint8Array([7]), pages: layoutsFrom(ir) });

let session: ReflowPreviewSession;
const failed = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	disk.files.clear();
	disk.mtimes.clear();
	disk.tick = 0;
	pageBuild.fn.mockReset();
	buildPdf.fn.mockReset();
	pageBuild.fn.mockImplementation(async (_e, _d, ir) => buildOutput(ir));
	buildPdf.fn.mockImplementation(async (_e, _d, ir) => buildOutput(ir));
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
				{ index: 0, width: 100, height: 100, paragraphs: [], obstacles: [] },
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

	it("hits when only paragraph draw order jitters between runs", async () => {
		const cache = createReflowBuildCache({
			paperKey: "papers/demo",
			pdfBytes: new TextEncoder().encode("pdf-one"),
		});
		const paragraph = (id: string) => ({
			id,
			pageIndex: 0,
			box: { x: 10, y: 10, w: 80, h: 20 },
			characters: [],
			formulas: [],
			styles: {},
			source: id,
			protectedText: id,
			style: {
				font: "Times",
				size: 10,
				bold: false,
				italic: false,
				color: { r: 0, g: 0, b: 0 },
			},
			firstLineIndent: 0,
			heading: false,
		});
		const documentWithOrder = (ids: string[]) => ({
			version: 1 as const,
			pages: [
				{
					index: 0,
					width: 100,
					height: 100,
					paragraphs: ids.map(paragraph),
					obstacles: [],
				},
			],
		});
		const translations = new Map([
			["a", "译文甲"],
			["b", "译文乙"],
		]);
		await cache.writeFinal(
			documentWithOrder(["a", "b"]),
			translations,
			fontBytes,
			new Uint8Array([1]),
		);
		expect(
			await cache.readFinal(
				documentWithOrder(["b", "a"]),
				translations,
				fontBytes,
			),
		).not.toBeNull();
	});

	it("keeps only the newest finals per paper and sweeps legacy page files", async () => {
		const cache = createReflowBuildCache({
			paperKey: "papers/demo",
			pdfBytes: new TextEncoder().encode("pdf-one"),
		});
		const ir = {
			version: 1 as const,
			pages: [
				{ index: 0, width: 100, height: 100, paragraphs: [], obstacles: [] },
			],
		};
		const write = (t: string) =>
			cache.writeFinal(
				ir,
				new Map([["p0", t]]),
				fontBytes,
				new Uint8Array([1]),
			);
		await write("one");
		await write("two");
		const prefix = [...disk.files.keys()][0]?.match(
			/reflow-build\/(.+)-final-/,
		)?.[1];
		expect(prefix).toBeTruthy();
		seedDiskFile(`${prefix}-p0003-legacy.pdf`, new Uint8Array([9]));
		seedDiskFile(`otherpaper-p0003-keep.pdf`, new Uint8Array([9]));

		await write("three");

		const names = [...disk.files.keys()].map((path) =>
			path.slice(path.lastIndexOf("/") + 1),
		);
		expect(names.filter((name) => name.includes("-final-"))).toHaveLength(2);
		expect(names.join("\n")).not.toContain(`${prefix}-p0003`);
		expect(names.join("\n")).toContain("otherpaper-p0003-keep.pdf");
		// The two newest finals stay readable; the oldest one is gone.
		expect(
			await cache.readFinal(ir, new Map([["p0", "two"]]), fontBytes),
		).not.toBeNull();
		expect(
			await cache.readFinal(ir, new Map([["p0", "one"]]), fontBytes),
		).toBeNull();
		expect(
			await cache.readFinal(ir, new Map([["p0", "three"]]), fontBytes),
		).not.toBeNull();
	});

	it("serves the final build from cache without invoking the builder", async () => {
		const cache: ReflowBuildCacheStore = {
			readFinal: vi.fn(async () => new Uint8Array([9, 9])),
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
		const items = [item("p0", 0), item("p1", 1)];
		session.update(items, [], false);
		await vi.waitFor(() => expect(session.busy).toBe(false));
		expect(buildPdf.fn).not.toHaveBeenCalled();
		expect(cache.writeFinal).not.toHaveBeenCalled();
		// Every page is repainted from the cached bytes, then the export
		// output is published.
		expect(render).toHaveBeenCalledTimes(2);
		expect(session.output).toEqual(new Uint8Array([9, 9]));
		const decorated = session.decorate(items);
		expect(decorated[0]?.reflowPreview).toBeTruthy();
		expect(decorated[0]?.reflowLayout?.id).toBe("p0");
		expect(decorated[1]?.reflowLayout?.id).toBe("p1");
	});

	it("persists a freshly built final document for the next run", async () => {
		const cache: ReflowBuildCacheStore = {
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
		session.update([item("p0", 0), item("p1", 1)], [], false);
		await vi.waitFor(() => expect(session.busy).toBe(false));
		expect(buildPdf.fn).toHaveBeenCalledTimes(1);
		expect(cache.writeFinal).toHaveBeenCalledTimes(1);
		const [, , , writeBytes] = vi.mocked(cache.writeFinal).mock.calls[0];
		expect(writeBytes).toEqual(new Uint8Array([7]));
	});

	it("never persists per-page builds, even with a cache attached", async () => {
		const cache: ReflowBuildCacheStore = {
			readFinal: vi.fn(async () => new Uint8Array([9, 9])),
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
		expect(pageBuild.fn).toHaveBeenCalledTimes(2);
		expect(buildPdf.fn).not.toHaveBeenCalled();
		expect(cache.readFinal).not.toHaveBeenCalled();
		expect(cache.writeFinal).not.toHaveBeenCalled();
		expect(render).toHaveBeenCalledTimes(2);
	});
});
