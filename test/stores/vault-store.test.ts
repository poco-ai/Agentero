import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	getVaultState,
	setCreateDraft,
	setRecentVaults,
	setTree,
	setTreeLoading,
	setTreeSelectedPath,
	setVaultPath,
	vaultStore,
} from "@/stores/vault-store";

function reset() {
	vaultStore.store.setState({
		vaultPath: null,
		tree: [],
		treeLoading: false,
		treeSelectedPath: null,
		createDraft: null,
		recentVaults: [],
	});
}

beforeEach(reset);
afterEach(reset);

describe("vault-store", () => {
	it("setters accept plain values (useState-compatible)", () => {
		setVaultPath("/vault");
		setTreeLoading(true);
		setTreeSelectedPath("/vault/papers");
		setRecentVaults(["/a", "/b"]);
		setCreateDraft({ kind: "folder", parentPath: "/vault" });

		const s = getVaultState();
		expect(s.vaultPath).toBe("/vault");
		expect(s.treeLoading).toBe(true);
		expect(s.treeSelectedPath).toBe("/vault/papers");
		expect(s.recentVaults).toEqual(["/a", "/b"]);
		expect(s.createDraft).toEqual({ kind: "folder", parentPath: "/vault" });
	});

	it("setters accept an updater function", () => {
		setTree([{ id: "a", name: "a", path: "/a", kind: "directory" }]);
		setTree((prev) => [
			...prev,
			{ id: "b", name: "b", path: "/b", kind: "file" },
		]);
		expect(getVaultState().tree.map((n) => n.id)).toEqual(["a", "b"]);
	});

	it("each setter updates only its own slice", () => {
		setVaultPath("/vault");
		setTreeSelectedPath("/vault/x");
		// Updating one field leaves the others intact.
		setTreeLoading(true);
		const s = getVaultState();
		expect(s.vaultPath).toBe("/vault");
		expect(s.treeSelectedPath).toBe("/vault/x");
		expect(s.treeLoading).toBe(true);
	});
});
