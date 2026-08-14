import { describe, expect, it } from "vitest";
import { paperAssetDownloadReasons } from "@/lib/paper/assets";
import {
	collectDefenseMaterialRelPaths,
	collectMarkdownRelPaths,
	collectTreeRefreshTargets,
	collectWikiTargetRelPaths,
	type FileNode,
	isEagerTreeRel,
	isMarkdownPath,
	isPathMissingError,
	normalizePathKey,
	paperRelFromNotes,
	pendingDirsAmongExpanded,
	removeTreeNode,
	replaceTreeNodeChildren,
	resolveCreateParent,
	shouldIgnoreTreeName,
	treeFindNode,
	treeHasPendingChildren,
} from "@/lib/vault";

function dir(
	path: string,
	children: FileNode[],
	extra?: Partial<FileNode>,
): FileNode {
	const name = path.split("/").pop() ?? path;
	return { id: path, name, path, kind: "directory", children, ...extra };
}

function file(path: string): FileNode {
	const name = path.split("/").pop() ?? path;
	return { id: path, name, path, kind: "file" };
}

const tree: FileNode[] = [
	dir("/v/papers", [
		dir("/v/papers/x", [
			file("/v/papers/x/NOTES.md"),
			file("/v/papers/x/a.pdf"),
		]),
	]),
	file("/v/notes/todo.md"),
	file("/v/readme.txt"),
];

describe("normalizePathKey", () => {
	it("lowercases, forward-slashes, and trims trailing slashes", () => {
		expect(normalizePathKey("C:\\V\\Papers\\")).toBe("c:/v/papers");
		expect(normalizePathKey("/v/Papers/x/")).toBe("/v/papers/x");
	});
});

describe("treeFindNode", () => {
	it("finds a node case-insensitively at any depth", () => {
		expect(treeFindNode(tree, "/V/PAPERS/X")?.kind).toBe("directory");
		expect(treeFindNode(tree, "/v/papers/x/a.pdf")?.name).toBe("a.pdf");
	});

	it("returns undefined when absent", () => {
		expect(treeFindNode(tree, "/v/missing")).toBeUndefined();
	});
});

describe("resolveCreateParent", () => {
	it("uses the vault root when nothing is selected", () => {
		expect(resolveCreateParent("/v", null, tree)).toBe("/v");
	});

	it("returns a selected directory as-is", () => {
		expect(resolveCreateParent("/v", "/v/papers/x", tree)).toBe("/v/papers/x");
	});

	it("returns the parent directory of a selected file", () => {
		expect(resolveCreateParent("/v", "/v/papers/x/a.pdf", tree)).toBe(
			"/v/papers/x",
		);
	});
});

describe("collectMarkdownRelPaths", () => {
	it("flattens only Markdown files as vault-relative paths", () => {
		expect(collectMarkdownRelPaths(tree, "/v").sort()).toEqual([
			"notes/todo.md",
			"papers/x/NOTES.md",
		]);
	});
});

describe("collectDefenseMaterialRelPaths", () => {
	it("includes supported defense files and excludes unrelated files", () => {
		expect(collectDefenseMaterialRelPaths(tree, "/v").sort()).toEqual([
			"notes/todo.md",
			"papers/x/NOTES.md",
			"papers/x/a.pdf",
			"readme.txt",
		]);
	});
});

describe("collectWikiTargetRelPaths", () => {
	it("includes Markdown, image, and PDF targets", () => {
		expect(collectWikiTargetRelPaths(tree, "/v").sort()).toEqual([
			"notes/todo.md",
			"papers/x/NOTES.md",
			"papers/x/a.pdf",
		]);
	});
});

describe("isMarkdownPath", () => {
	it("recognizes Markdown files at any vault path", () => {
		for (const path of [
			"/v/README.md",
			"/v/notes/todo.md",
			"/v/plans/2026/review.mdx",
			"/v/papers/topic/paper/PAPER.md",
			"remote:session/notes/review.markdown",
		]) {
			expect(isMarkdownPath(path)).toBe(true);
		}
	});
});

describe("paperRelFromNotes", () => {
	it("derives the paper folder rel path from a NOTES.md path", () => {
		expect(paperRelFromNotes("/v/papers/x/NOTES.md", "/v")).toBe("papers/x");
	});

	it("returns empty string when the paper folder is the vault root", () => {
		expect(paperRelFromNotes("/v/NOTES.md", "/v")).toBe("");
	});

	it("returns null when either path is missing", () => {
		expect(paperRelFromNotes(null, "/v")).toBeNull();
		expect(paperRelFromNotes("/v/papers/x/NOTES.md", null)).toBeNull();
	});
});

describe("shouldIgnoreTreeName", () => {
	it("skips VCS, cache, venv, and Host-only dirs", () => {
		for (const n of [
			".git",
			".agentero",
			".venv",
			"venv",
			"node_modules",
			"__pycache__",
			"site-packages",
			".codex",
			"foo.egg-info",
		]) {
			expect(shouldIgnoreTreeName(n)).toBe(true);
		}
	});

	it("keeps product surface and normal names", () => {
		expect(shouldIgnoreTreeName(".agents")).toBe(false);
		expect(shouldIgnoreTreeName(".env.example")).toBe(false);
		expect(shouldIgnoreTreeName("papers")).toBe(false);
		expect(shouldIgnoreTreeName("src")).toBe(false);
		expect(shouldIgnoreTreeName("AGENTS.md")).toBe(false);
	});
});

describe("isEagerTreeRel", () => {
	it("treats papers/notes/plans/.agents as eager", () => {
		expect(isEagerTreeRel("papers")).toBe(true);
		expect(isEagerTreeRel("papers/topic/x")).toBe(true);
		expect(isEagerTreeRel("notes/todo.md")).toBe(true);
		expect(isEagerTreeRel("plans")).toBe(true);
		expect(isEagerTreeRel(".agents/skills")).toBe(true);
	});

	it("treats other vault-root trees as lazy", () => {
		expect(isEagerTreeRel("src")).toBe(false);
		expect(isEagerTreeRel("src/agents")).toBe(false);
		expect(isEagerTreeRel("thesis")).toBe(false);
		expect(isEagerTreeRel("scripts")).toBe(false);
	});
});

describe("isPathMissingError", () => {
	it("matches SFTP / OS not-found messages", () => {
		expect(
			isPathMissingError(
				new Error(
					"sftp list /home/u/vault/papers/test: Sftp server reported error kind NoSuchFile, msg: Err Message: No such file",
				),
			),
		).toBe(true);
		expect(
			isPathMissingError(new Error("ENOENT: no such file or directory")),
		).toBe(true);
		expect(isPathMissingError("directory does not exist")).toBe(true);
		expect(isPathMissingError(new Error("permission denied"))).toBe(false);
	});
});

describe("removeTreeNode", () => {
	it("drops the target and its descendants", () => {
		const next = removeTreeNode(tree, "/v/papers/x");
		expect(treeFindNode(next, "/v/papers/x")).toBeUndefined();
		expect(treeFindNode(next, "/v/papers/x/NOTES.md")).toBeUndefined();
		expect(treeFindNode(next, "/v/papers")?.kind).toBe("directory");
		expect(treeFindNode(next, "/v/notes/todo.md")?.kind).toBe("file");
	});

	it("is a no-op when the path is absent", () => {
		expect(removeTreeNode(tree, "/v/missing")).toEqual(tree);
	});
});

describe("replaceTreeNodeChildren / lazy pending", () => {
	/** After open: non-eager `src/` has one listed level; nested dirs stay pending. */
	const lazyTree: FileNode[] = [
		dir("/v/papers", [dir("/v/papers/x", [file("/v/papers/x/NOTES.md")])]),
		dir("/v/src", [
			file("/v/src/README.md"),
			dir("/v/src/agents", [], { childrenPending: true }),
		]),
	];

	it("replaces children of an expanded pending folder", () => {
		const next = replaceTreeNodeChildren(lazyTree, "/v/src/agents", [
			file("/v/src/agents/README.md"),
			dir("/v/src/agents/benchmark", [], { childrenPending: true }),
		]);
		const agents = treeFindNode(next, "/v/src/agents");
		expect(agents?.childrenPending).toBe(false);
		expect(agents?.children?.map((c) => c.name).sort()).toEqual([
			"README.md",
			"benchmark",
		]);
		expect(treeFindNode(next, "/v/src/agents/benchmark")?.childrenPending).toBe(
			true,
		);
		// Sibling listing under src unchanged
		expect(treeFindNode(next, "/v/src/README.md")?.kind).toBe("file");
	});

	it("lists expanded pending dirs only", () => {
		expect(treeHasPendingChildren(lazyTree)).toBe(true);
		expect(
			pendingDirsAmongExpanded(lazyTree, new Set(["/v/src/agents"])),
		).toEqual(["/v/src/agents"]);
		expect(pendingDirsAmongExpanded(lazyTree, new Set(["/v/src"]))).toEqual([]);
	});
});

describe("collectTreeRefreshTargets", () => {
	const refreshTree: FileNode[] = [
		dir("/v/papers", [
			dir("/v/papers/x", [
				file("/v/papers/x/NOTES.md"),
				dir("/v/papers/x/source", [], { childrenPending: true }),
			]),
		]),
		dir("/v/src", [
			file("/v/src/README.md"),
			dir("/v/src/agents", [], { childrenPending: true }),
		]),
	];

	it("maps changed files to their loaded parent directory", () => {
		expect(
			collectTreeRefreshTargets(refreshTree, "/v", ["/v/papers/x/a.pdf"]),
		).toEqual(["/v/papers/x"]);
	});

	it("resolves changes inside a pending subtree to the nearest loaded ancestor", () => {
		expect(
			collectTreeRefreshTargets(refreshTree, "/v", [
				"/v/papers/x/source/figs/a.png",
				"/v/src/agents/deep/file.ts",
			])?.sort(),
		).toEqual(["/v/papers/x", "/v/src"]);
	});

	it("coalesces descendants under an eager ancestor target", () => {
		expect(
			collectTreeRefreshTargets(refreshTree, "/v", [
				"/v/papers/new-dir",
				"/v/papers/x/b.pdf",
			]),
		).toEqual(["/v/papers"]);
	});

	it("skips ignored names and returns [] when nothing visible changed", () => {
		expect(
			collectTreeRefreshTargets(refreshTree, "/v", [
				"/v/papers/x/.git/config",
				"/v/.agentero/catalog.sqlite",
				"/other/vault/file.md",
			]),
		).toEqual([]);
	});

	it("falls back to a full rebuild for vault-root changes", () => {
		expect(collectTreeRefreshTargets(refreshTree, "/v", ["/v/new.md"])).toBe(
			null,
		);
		expect(collectTreeRefreshTargets(refreshTree, "/v", ["/v"])).toBe(null);
	});
});

describe("paperAssetDownloadReasons", () => {
	it("trusts hasTex on a lazy source/ shell (no listed .tex children)", () => {
		const paper = dir("/v/papers/x", [
			file("/v/papers/x/metadata.json"),
			file("/v/papers/x/a.pdf"),
			dir("/v/papers/x/source", [], { childrenPending: true, hasTex: true }),
		]);
		expect(paperAssetDownloadReasons(paper)).toEqual([]);
	});

	it("flags noBody when the source/ shell has no TeX and PAPER.md is absent", () => {
		const paper = dir("/v/papers/x", [
			file("/v/papers/x/metadata.json"),
			file("/v/papers/x/a.pdf"),
			dir("/v/papers/x/source", [], { childrenPending: true, hasTex: false }),
		]);
		expect(paperAssetDownloadReasons(paper)).toEqual(["noBody"]);
	});

	it("still detects listed .tex files without the flag", () => {
		const paper = dir("/v/papers/x", [
			file("/v/papers/x/metadata.json"),
			file("/v/papers/x/a.pdf"),
			dir("/v/papers/x/source", [file("/v/papers/x/source/main.tex")]),
		]);
		expect(paperAssetDownloadReasons(paper)).toEqual([]);
	});
});
