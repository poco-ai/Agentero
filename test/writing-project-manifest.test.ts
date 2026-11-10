import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	readDir: vi.fn(),
	readTextFile: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-fs", () => mocks);
vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/vault/scope", () => ({ ensureLocalFsScope: async () => {} }));

import {
	explicitWritingProjectForPath,
	hasWritingMainFile,
	listExplicitWritingProjects,
	parseWritingManifest,
	type WritingManifest,
} from "@/lib/writing/project-manifest";

const vault = "/vault";
const shelf = "/vault/thesis";
const year = "/vault/thesis/2026";
const root = "/vault/thesis/2026/Paper";
const manifest: WritingManifest = {
	schemaVersion: 1,
	projectId: "2a616bc4-cda8-4df4-a466-0e1a886d051b",
	name: "Paper",
	mainFile: "src/paper.tex",
	compiler: "xelatex",
};
const file = (name: string) => ({
	name,
	isFile: true,
	isDirectory: false,
	isSymlink: false,
});
const dir = (name: string) => ({
	name,
	isFile: false,
	isDirectory: true,
	isSymlink: false,
});
const entries = new Map<string, ReturnType<typeof file>[]>();
beforeEach(() => {
	entries.clear();
	entries.set(vault, [dir("thesis")]);
	entries.set(shelf, [dir("2026"), file("main.tex")]);
	entries.set(year, [dir("Paper")]);
	entries.set(root, [file("agentero.project.json"), dir("src")]);
	entries.set(`${root}/src`, [file("paper.tex")]);
	mocks.readDir.mockImplementation(async (path: string) => {
		const children = entries.get(path);
		if (!children) throw new Error(`Missing: ${path}`);
		return children;
	});
	mocks.readTextFile.mockResolvedValue(JSON.stringify(manifest));
});

describe("writing project manifests", () => {
	it("discovers the declared root at any classification depth", async () => {
		expect(await listExplicitWritingProjects(vault)).toEqual([
			{ directory: root, manifest, root: `${root}/src/paper.tex` },
		]);
		expect(await explicitWritingProjectForPath(vault, year, true)).toBeNull();
		expect(
			await explicitWritingProjectForPath(vault, `${root}/src/paper.tex`),
		).toMatchObject({ directory: root, manifest });
	});

	it("keeps an empty project identifiable and detects an unsafe main path", async () => {
		const project = await explicitWritingProjectForPath(vault, root, true);
		if (!project) throw new Error("Expected explicit project");
		entries.set(`${root}/src`, []);
		expect(await hasWritingMainFile(vault, project)).toBe(false);
		entries.set(`${root}/src`, [{ ...file("paper.tex"), isSymlink: true }]);
		await expect(hasWritingMainFile(vault, project)).rejects.toThrow();
	});

	it("rejects an explicitly nested project instead of changing ownership", async () => {
		entries.get(`${root}/src`)?.push(file("agentero.project.json"));
		await expect(
			explicitWritingProjectForPath(vault, `${root}/src/paper.tex`),
		).rejects.toThrow();
	});

	it.each([
		"../paper.tex",
		"src/../paper.tex",
		"/paper.tex",
		"src\\paper.tex",
		"D:/paper.tex",
	])("rejects an invalid portable main file path %s", (mainFile) =>
		expect(() =>
			parseWritingManifest(JSON.stringify({ ...manifest, mainFile })),
		).toThrow());
});
