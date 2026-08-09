import { describe, expect, it } from "vitest";
import {
	collectImageUrlCounts,
	createManagedAssetGc,
	formatMarkdownImageSyntax,
	isManagedMarkdownAssetUrl,
	isRemoteOrInlineImageUrl,
	joinFilePath,
	parentDir,
	parseImagePayload,
	resolveMarkdownImageAbs,
	sanitizeAssetFileName,
} from "@/lib/markdown/image";

describe("markdown-image path helpers", () => {
	it("parentDir handles posix and windows separators", () => {
		expect(parentDir("/vault/papers/x/NOTES.md")).toBe("/vault/papers/x");
		expect(parentDir("C:\\vault\\papers\\x\\NOTES.md")).toBe(
			"C:\\vault\\papers\\x",
		);
	});

	it("joinFilePath preserves separator style", () => {
		expect(joinFilePath("/vault/papers/x", "assets")).toBe(
			"/vault/papers/x/assets",
		);
		expect(joinFilePath("C:\\vault\\papers\\x", "assets")).toBe(
			"C:\\vault\\papers\\x\\assets",
		);
	});

	it("resolveMarkdownImageAbs maps ./assets/ relative to the md file", () => {
		expect(
			resolveMarkdownImageAbs(
				"/vault/papers/1706.03762/NOTES.md",
				"./assets/figure.png",
			),
		).toBe("/vault/papers/1706.03762/assets/figure.png");

		expect(
			resolveMarkdownImageAbs(
				"/vault/papers/1706.03762/NOTES.md",
				"assets/figure.png",
			),
		).toBe("/vault/papers/1706.03762/assets/figure.png");

		expect(
			resolveMarkdownImageAbs(
				"C:\\vault\\papers\\x\\NOTES.md",
				"./assets/a.jpg",
			),
		).toBe("C:\\vault\\papers\\x\\assets\\a.jpg");
	});

	it("resolveMarkdownImageAbs rejects traversal and remote urls", () => {
		expect(
			resolveMarkdownImageAbs("/vault/a.md", "./assets/../../secret.png"),
		).toBeNull();
		expect(
			resolveMarkdownImageAbs("/vault/a.md", "https://x/y.png"),
		).toBeNull();
		expect(
			resolveMarkdownImageAbs("/vault/a.md", "data:image/png;base64,aa"),
		).toBe(null);
		expect(resolveMarkdownImageAbs("/vault/a.md", "blob:http://x")).toBeNull();
	});

	it("isRemoteOrInlineImageUrl", () => {
		expect(isRemoteOrInlineImageUrl("https://a/b.png")).toBe(true);
		expect(isRemoteOrInlineImageUrl("./assets/x.png")).toBe(false);
	});

	it("sanitizeAssetFileName strips path segments", () => {
		expect(sanitizeAssetFileName("../evil.png")).toBe("evil.png");
		expect(sanitizeAssetFileName("foo/bar.png")).toBe("bar.png");
		expect(sanitizeAssetFileName("")).toBe("image");
	});

	it("isManagedMarkdownAssetUrl only matches assets/ links", () => {
		expect(isManagedMarkdownAssetUrl("./assets/a.png")).toBe(true);
		expect(isManagedMarkdownAssetUrl("assets/a.png")).toBe(true);
		expect(isManagedMarkdownAssetUrl("https://x/a.png")).toBe(false);
		expect(isManagedMarkdownAssetUrl("./figures/a.png")).toBe(false);
	});

	it("formatMarkdownImageSyntax", () => {
		expect(formatMarkdownImageSyntax("cap", "./assets/x.png")).toBe(
			"![cap](./assets/x.png)",
		);
		expect(formatMarkdownImageSyntax("", "./assets/x.png")).toBe(
			"![](./assets/x.png)",
		);
	});

	it("collectImageUrlCounts walks nested nodes", () => {
		const counts = collectImageUrlCounts([
			{
				type: "p",
				children: [{ text: "hi" }],
			},
			{
				type: "img",
				url: "./assets/a.png",
				children: [{ text: "" }],
			},
			{
				type: "img",
				url: "./assets/a.png",
				children: [{ text: "" }],
			},
			{
				type: "img",
				url: "https://example.com/b.png",
				children: [{ text: "" }],
			},
		]);
		expect(counts.get("./assets/a.png")).toBe(2);
		expect(counts.get("https://example.com/b.png")).toBe(1);
	});
});

describe("createManagedAssetGc", () => {
	it("schedules delete on drop and cancels when the url returns", async () => {
		const deleted: string[] = [];
		const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
		let id = 0;
		const setTimer = ((fn: () => void, _ms?: number) => {
			const handle = ++id as unknown as ReturnType<typeof setTimeout>;
			timers.set(handle, fn);
			return handle;
		}) as typeof setTimeout;
		const clearTimer = ((handle: ReturnType<typeof setTimeout>) => {
			timers.delete(handle);
		}) as typeof clearTimeout;

		const gc = createManagedAssetGc({
			debounceMs: 1000,
			setTimer,
			clearTimer,
			deleteAsset: async (_md, url) => {
				deleted.push(url);
				return true;
			},
		});

		const md = "/vault/notes/x.md";
		const url = "./assets/a.png";
		gc.observe(md, new Map([[url, 1]]), new Map());
		expect(gc.pendingUrls()).toEqual([url]);
		expect(deleted).toEqual([]);

		// Paste / undo before timer → cancel
		gc.observe(md, new Map(), new Map([[url, 1]]));
		expect(gc.pendingUrls()).toEqual([]);
		// fire any leftover timers (should be none)
		for (const fn of timers.values()) fn();
		expect(deleted).toEqual([]);

		// Drop again and flush
		gc.observe(md, new Map([[url, 1]]), new Map());
		expect(gc.pendingUrls()).toEqual([url]);
		const n = await gc.flush();
		expect(n).toBe(1);
		expect(deleted).toEqual([url]);
		expect(gc.pendingUrls()).toEqual([]);
	});

	it("ignores remote urls", () => {
		const gc = createManagedAssetGc({
			debounceMs: 10,
			deleteAsset: async () => true,
		});
		gc.observe("/vault/a.md", new Map([["https://x/y.png", 1]]), new Map());
		expect(gc.pendingUrls()).toEqual([]);
		gc.cancelAll();
	});
});

describe("parseImagePayload", () => {
	it("decodes a minimal data URL", () => {
		// "hi" as base64
		const data = "data:image/png;base64,aGk=";
		const parsed = parseImagePayload(data);
		expect(parsed.ext).toBe("png");
		expect(parsed.mime).toBe("image/png");
		expect(Array.from(parsed.bytes)).toEqual([104, 105]);
	});

	it("defaults ArrayBuffer to png", () => {
		const buf = new Uint8Array([1, 2, 3]).buffer;
		const parsed = parseImagePayload(buf);
		expect(parsed.ext).toBe("png");
		expect(parsed.bytes.length).toBe(3);
	});
});
