import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clearReflowCaches,
	reflowCacheUsage,
} from "@/lib/pdf/reflow/cache-manage";

const tree = vi.hoisted(() => ({
	files: new Map<string, number>(),
	dirs: new Set<string>(),
}));

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => tree.tauri !== false }));

vi.mock("@tauri-apps/api/path", () => ({
	appCacheDir: async () => "/app-cache",
	join: async (...parts: string[]) => parts.join("/"),
}));

vi.mock("@tauri-apps/plugin-fs", () => ({
	readDir: async (dir: string) => {
		const prefix = `${dir}/`;
		const seen = new Set<string>();
		const entries: {
			name: string;
			isFile: boolean;
			isDirectory: boolean;
			isSymlink: boolean;
		}[] = [];
		for (const key of [...tree.dirs, ...tree.files.keys()]) {
			if (!key.startsWith(prefix)) continue;
			const rest = key.slice(prefix.length);
			const name = rest.split("/")[0];
			if (!name || seen.has(name)) continue;
			seen.add(name);
			entries.push({
				name,
				isFile: tree.files.has(`${prefix}${name}`),
				isDirectory: tree.dirs.has(`${prefix}${name}`),
				isSymlink: false,
			});
		}
		return entries;
	},
	stat: async (path: string) => ({
		isFile: true,
		isDirectory: false,
		isSymlink: false,
		size: tree.files.get(path) ?? 0,
		mtime: new Date(0),
	}),
	remove: async (path: string) => {
		for (const key of [...tree.files.keys()])
			if (key === path || key.startsWith(`${path}/`)) tree.files.delete(key);
		for (const key of [...tree.dirs])
			if (key === path || key.startsWith(`${path}/`)) tree.dirs.delete(key);
	},
}));

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

beforeEach(() => {
	tree.files.clear();
	tree.dirs.clear();
	tree.tauri = true;
	seed("/app-cache", 0, true);
});

describe("reflow cache usage and cleanup", () => {
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
