import { describe, expect, it } from "vitest";
import { resolveTreeHighlightPath } from "@/components/sidebar/file-tree/hooks/use-tree-model";
import { pathKey } from "@/components/sidebar/file-tree/tree-helpers";
import {
	buildZoteroCollectionReferences,
	zoteroCollectionReferenceRelPath,
} from "@/components/sidebar/file-tree/zotero-collection-references";
import { LIBRARY_VIRTUAL_PATH, TRASH_VIRTUAL_PATH } from "@/lib/paper/api";
import type { PaperLibraryRow } from "@/lib/paper/types";
import type { FileNode } from "@/lib/vault";
import { normalizePathKey } from "@/lib/vault/path";

function dir(path: string, name: string, children: FileNode[] = []): FileNode {
	return { id: path, name, path, kind: "directory", children };
}

const nodes: FileNode[] = [
	dir("/vault/papers", "papers", [
		dir("/vault/papers/1706.03762", "1706.03762"),
	]),
	dir("/vault/notes", "notes"),
];
const byPathKey = new Map<string, FileNode>();
const walk = (list: FileNode[]) => {
	for (const n of list) {
		byPathKey.set(pathKey(n.path), n);
		if (n.children) walk(n.children);
	}
};
walk(nodes);

describe("resolveTreeHighlightPath", () => {
	it("maps the library virtual path to the papers/ folder row", () => {
		expect(resolveTreeHighlightPath(LIBRARY_VIRTUAL_PATH, byPathKey)).toBe(
			"/vault/papers",
		);
	});

	it("keeps other virtual paths as-is", () => {
		expect(resolveTreeHighlightPath(TRASH_VIRTUAL_PATH, byPathKey)).toBe(
			TRASH_VIRTUAL_PATH,
		);
	});

	it("resolves a path to its nearest existing directory", () => {
		expect(
			resolveTreeHighlightPath("/vault/papers/1706.03762/gone.md", byPathKey),
		).toBe("/vault/papers/1706.03762");
	});
});

describe("Zotero collection references", () => {
	it("adds a virtual reference only in the paper's other real collection folder", () => {
		const paper = {
			id: "attention",
			title: "Attention Is All You Need",
			path: "papers/Review/attention",
			tags: [
				"NLP",
				"@zotero:collection:Review",
				"@zotero:collection:Topics",
				"@zotero:collection-root:papers",
			],
		} as PaperLibraryRow;
		const review = dir("/vault/papers/Review", "Review");
		const topics = dir("/vault/papers/Topics", "Topics");
		const byPathKey = new Map([
			[normalizePathKey(review.path), review],
			[normalizePathKey(topics.path), topics],
		]);
		const refs = buildZoteroCollectionReferences({
			papers: [paper],
			vaultPath: "/vault",
			byPathKey,
		});

		expect(refs.get(review.path)).toBeUndefined();
		expect(refs.get(topics.path)?.map((ref) => ref.paper)).toEqual([paper]);
	});

	it("decodes a virtual reference without confusing it for a disk path", () => {
		const reference = buildZoteroCollectionReferences({
			papers: [
				{
					id: "attention",
					title: "Attention",
					path: "papers/Review/attention",
					tags: [
						"@zotero:collection:Review",
						"@zotero:collection:Topics",
						"@zotero:collection-root:papers",
					],
				} as PaperLibraryRow,
			],
			vaultPath: "/vault",
			byPathKey: new Map([
				[
					normalizePathKey("/vault/papers/Review"),
					dir("/vault/papers/Review", "Review"),
				],
				[
					normalizePathKey("/vault/papers/Topics"),
					dir("/vault/papers/Topics", "Topics"),
				],
			]),
		}).get("/vault/papers/Topics")?.[0]?.path;
		expect(reference && zoteroCollectionReferenceRelPath(reference)).toBe(
			"papers/Review/attention",
		);
	});
});
