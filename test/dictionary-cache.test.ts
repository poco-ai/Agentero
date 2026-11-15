import { beforeEach, expect, it, vi } from "vitest";

const files = vi.hoisted(
	() => new Map<string, { text: string; time: number }>(),
);
const fs = vi.hoisted(() => ({ fail: false }));
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/vault/path", () => ({
	joinVaultPath: (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/api/path", () => ({
	appCacheDir: async () => "/app-cache",
	join: async (...parts: string[]) => parts.join("/"),
}));
vi.mock("@tauri-apps/plugin-fs", () => ({
	exists: async (path: string) =>
		files.has(path) ||
		[...files.keys()].some((file) => file.startsWith(`${path}/`)),
	mkdir: async () => {
		if (fs.fail) throw new Error("read-only");
	},
	writeTextFile: async (path: string, text: string) => {
		files.set(path, { text, time: Date.now() });
	},
	readTextFile: async (path: string) => {
		if (!files.has(path)) throw new Error("missing");
		return files.get(path)?.text;
	},
	rename: async (from: string, to: string) => {
		const file = files.get(from);
		if (file) files.set(to, file);
		files.delete(from);
	},
	remove: async (path: string) => {
		files.delete(path);
	},
	stat: async (path: string) => {
		const file = files.get(path);
		if (!file) throw new Error("missing");
		return { size: file.text.length, mtime: new Date(file.time) };
	},
	readDir: async (dir: string) =>
		[...files.keys()]
			.filter((path) => path.startsWith(`${dir}/`))
			.map((path) => ({ name: path.slice(dir.length + 1), isFile: true })),
}));

beforeEach(() => {
	vi.resetModules();
	files.clear();
	fs.fail = false;
	vi.useRealTimers();
});

it("persists completed entries across renderer restarts without storing request metadata", async () => {
	let cache = await import("@/lib/translate/dictionary-cache");
	const key = await cache.dictionaryCacheKey({
		text: "resolution",
		surrounding: "private paper excerpt",
		apiKey: "private-key",
	});
	await cache.writeDictionaryCache(key, "分辨率", "/vault");
	expect([...files.keys()]).toEqual([
		`/vault/.agentero/cache/dictionary/${key}.json`,
	]);
	expect([...files.values()][0].text).not.toContain("private");
	vi.resetModules();
	cache = await import("@/lib/translate/dictionary-cache");
	expect(await cache.readDictionaryCache(key, "/vault")).toBe("分辨率");
	// Drain the asynchronous last-access update before the next test resets the fake filesystem.
	await cache.writeDictionaryCache(key, "分辨率", "/vault");
});

it("separates providers, models, languages, prompts and surrounding excerpts", async () => {
	const { dictionaryCacheKey } = await import(
		"@/lib/translate/dictionary-cache"
	);
	const base = {
		text: "resolution",
		provider: "a",
		model: "m1",
		target: "zh-CN",
		surrounding: "image resolution",
		prompt: "",
	};
	const key = await dictionaryCacheKey(base);
	for (const patch of [
		{ provider: "b" },
		{ model: "m2" },
		{ target: "en" },
		{ surrounding: "her resolution" },
		{ prompt: "brief" },
	])
		expect(await dictionaryCacheKey({ ...base, ...patch })).not.toBe(key);
});

it("treats corrupted, mismatched and expired disk entries as misses", async () => {
	const cache = await import("@/lib/translate/dictionary-cache");
	const key = await cache.dictionaryCacheKey("word");
	const path = `/vault/.agentero/cache/dictionary/${key}.json`;
	for (const text of [
		"{broken",
		JSON.stringify({ version: 2, key, result: "old", created: Date.now() }),
		JSON.stringify({
			version: 1,
			key: "wrong",
			result: "old",
			created: Date.now(),
		}),
		JSON.stringify({ version: 1, key, result: "old", created: 0 }),
	]) {
		files.set(path, { text, time: Date.now() });
		expect(await cache.readDictionaryCache(key, "/vault")).toBeUndefined();
	}
});

it("bounds storage and clears only the selected Vault's dictionary cache", async () => {
	const cache = await import("@/lib/translate/dictionary-cache");
	for (let index = 0; index < 258; index++)
		await cache.writeDictionaryCache(
			await cache.dictionaryCacheKey(index),
			`entry ${index}`,
			"/vault",
		);
	expect(files.size).toBe(256);
	files.set("/vault/.agentero/catalog.sqlite", { text: "catalog", time: 0 });
	const key = await cache.dictionaryCacheKey("another vault");
	await cache.writeDictionaryCache(key, "keep", "/other");
	await cache.clearDictionaryCache("/vault");
	expect(files.size).toBe(2);
	expect(await cache.readDictionaryCache(key, "/other")).toBe("keep");
	expect(files.has("/vault/.agentero/catalog.sqlite")).toBe(true);
});

it("keeps successful lookups in memory when the filesystem is read-only", async () => {
	const cache = await import("@/lib/translate/dictionary-cache");
	const key = await cache.dictionaryCacheKey("term");
	fs.fail = true;
	await expect(
		cache.writeDictionaryCache(key, "词义", "/vault"),
	).resolves.toBeUndefined();
	expect(await cache.readDictionaryCache(key, "/vault")).toBe("词义");
	expect(files.size).toBe(0);
});

it("invalidates a renderer's memory hit after a separate Settings WebView clears the disk cache", async () => {
	const reader = await import("@/lib/translate/dictionary-cache");
	const key = await reader.dictionaryCacheKey("word");
	await reader.writeDictionaryCache(key, "definition", "/vault");
	vi.resetModules();
	const settings = await import("@/lib/translate/dictionary-cache");
	await settings.clearDictionaryCache("/vault");
	expect(await reader.readDictionaryCache(key, "/vault")).toBeUndefined();
});

it("retains a recently used entry during disk eviction and expires memory entries", async () => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
	const cache = await import("@/lib/translate/dictionary-cache");
	const keys: string[] = [];
	for (let index = 0; index < 256; index++) {
		keys.push(await cache.dictionaryCacheKey(index));
		await cache.writeDictionaryCache(keys[index], `entry ${index}`, "/vault");
		vi.setSystemTime(Date.now() + 1);
	}
	vi.setSystemTime(Date.now() + 61_000);
	expect(await cache.readDictionaryCache(keys[0], "/vault")).toBe("entry 0");
	await cache.writeDictionaryCache(
		await cache.dictionaryCacheKey("new"),
		"new",
		"/vault",
	);
	expect(files.has(`/vault/.agentero/cache/dictionary/${keys[0]}.json`)).toBe(
		true,
	);
	expect(files.has(`/vault/.agentero/cache/dictionary/${keys[1]}.json`)).toBe(
		false,
	);
	vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);
	expect(await cache.readDictionaryCache(keys[0], "/vault")).toBeUndefined();
	vi.useRealTimers();
});
