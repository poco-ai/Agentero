import { describe, expect, it } from "vitest";

import {
	ancestorPaths,
	isVirtualTreePath,
	pathKey,
} from "@/components/layout/file-tree-helpers";
import { LIBRARY_VIRTUAL_PATH, TRASH_VIRTUAL_PATH } from "@/lib/papers-api";

describe("file-tree-helpers", () => {
	describe("pathKey", () => {
		it("normalizes separators, trailing slash, and case", () => {
			expect(pathKey("C:\\Vault\\Papers\\")).toBe("c:/vault/papers");
			expect(pathKey("/Vault/Papers/")).toBe("/vault/papers");
			expect(pathKey("/vault/papers")).toBe("/vault/papers");
		});
	});

	describe("ancestorPaths", () => {
		it("lists ancestor dirs root-ward, excluding the vault root and target", () => {
			expect(ancestorPaths("/vault/papers/nlp/paper1", "/vault")).toEqual([
				"/vault/papers",
				"/vault/papers/nlp",
			]);
		});

		it("stops at the vault root regardless of separator/case", () => {
			expect(ancestorPaths("/Vault/papers/x", "/vault")).toEqual([
				"/Vault/papers",
			]);
		});

		it("returns all ancestors when no vault root is given", () => {
			expect(ancestorPaths("/a/b/c", null)).toEqual(["/a", "/a/b"]);
		});
	});

	describe("isVirtualTreePath", () => {
		it("recognizes the library and trash virtual paths", () => {
			expect(isVirtualTreePath(LIBRARY_VIRTUAL_PATH)).toBe(true);
			expect(isVirtualTreePath(TRASH_VIRTUAL_PATH)).toBe(true);
			expect(isVirtualTreePath("/vault/papers")).toBe(false);
		});
	});
});
