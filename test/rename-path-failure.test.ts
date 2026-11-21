import { afterEach, describe, expect, it, vi } from "vitest";
import i18n from "@/i18n";
import { notifyError } from "@/lib/core/notify";
import {
	createVaultDirectory,
	removeVaultPath,
	vaultPathExists,
} from "@/lib/vault";
import { confirmRenamePath } from "@/lib/vault/actions";
import { refreshTree, vaultStore } from "@/lib/vault/store";
import { moveVaultPath } from "@/lib/wiki";

vi.mock("@/lib/core/notify", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/core/notify")>();
	return { ...actual, notifyError: vi.fn() };
});

vi.mock("@/lib/vault", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/vault")>();
	return {
		...actual,
		vaultPathExists: vi.fn(),
		createVaultDirectory: vi.fn(),
		removeVaultPath: vi.fn(),
	};
});

vi.mock("@/lib/vault/store", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/vault/store")>();
	return { ...actual, refreshTree: vi.fn(async () => {}) };
});

vi.mock("@/lib/wiki", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/wiki")>();
	return { ...actual, moveVaultPath: vi.fn() };
});

const directoryPath = "/vault/papers/old";

afterEach(() => {
	vaultStore.setState({
		vaultPath: null,
		tree: [],
		renameDraft: null,
		busy: false,
	});
	vi.clearAllMocks();
});

describe("confirmRenamePath failure", () => {
	it("clears the rename draft when the host rejects the move", async () => {
		vaultStore.setState({
			vaultPath: "/vault",
			tree: [
				{
					id: directoryPath,
					name: "old",
					path: directoryPath,
					kind: "directory",
					children: [],
				},
			],
			renameDraft: { path: directoryPath, currentName: "old" },
			busy: false,
		});
		vi.mocked(moveVaultPath).mockRejectedValueOnce(
			new Error("directory not empty"),
		);

		await expect(confirmRenamePath(directoryPath, "taken")).rejects.toThrow(
			"directory not empty",
		);

		const state = vaultStore.getState();
		expect(state.renameDraft).toBeNull();
		expect(state.busy).toBe(false);
		expect(state.tree[0]?.name).toBe("old");
		expect(notifyError).toHaveBeenCalledWith("directory not empty");
		expect(moveVaultPath).toHaveBeenCalledOnce();
	});

	it("toasts the generic message when the host failure is not an Error", async () => {
		vaultStore.setState({
			vaultPath: "/vault",
			tree: [
				{
					id: directoryPath,
					name: "old",
					path: directoryPath,
					kind: "directory",
					children: [],
				},
			],
			renameDraft: { path: directoryPath, currentName: "old" },
		});
		vi.mocked(moveVaultPath).mockRejectedValueOnce("occupied");

		await expect(confirmRenamePath(directoryPath, "taken")).rejects.toBe(
			"occupied",
		);

		expect(vaultStore.getState().renameDraft).toBeNull();
		expect(vaultStore.getState().busy).toBe(false);
		expect(notifyError).toHaveBeenCalledWith(
			i18n.t("sidebar:fileTree.renameFailed"),
		);
	});

	it("clears the draft after removing a folder the failed rename created", async () => {
		const filePath = "/vault/notes/foo.md";
		vaultStore.setState({
			vaultPath: "/vault",
			tree: [
				{
					id: filePath,
					name: "foo.md",
					path: filePath,
					kind: "file",
				},
			],
			renameDraft: { path: filePath, currentName: "foo.md" },
			busy: false,
		});
		vi.mocked(vaultPathExists).mockResolvedValueOnce(false);
		vi.mocked(createVaultDirectory).mockResolvedValueOnce(undefined);
		vi.mocked(moveVaultPath).mockRejectedValueOnce(new Error("occupied"));
		vi.mocked(removeVaultPath).mockResolvedValueOnce(undefined);

		await expect(confirmRenamePath(filePath, "bar")).rejects.toThrow(
			"occupied",
		);

		expect(createVaultDirectory).toHaveBeenCalledOnce();
		expect(removeVaultPath).toHaveBeenCalledOnce();
		expect(refreshTree).toHaveBeenCalledOnce();
		expect(vaultStore.getState().renameDraft).toBeNull();
		expect(vaultStore.getState().busy).toBe(false);
		expect(vaultStore.getState().tree[0]?.name).toBe("foo.md");
		expect(notifyError).toHaveBeenCalledWith("occupied");
	});

	it("drops a rename draft when no vault is open", async () => {
		vaultStore.setState({
			vaultPath: null,
			renameDraft: { path: directoryPath, currentName: "old" },
		});

		await confirmRenamePath(directoryPath, "taken");

		expect(vaultStore.getState().renameDraft).toBeNull();
		expect(notifyError).not.toHaveBeenCalled();
		expect(moveVaultPath).not.toHaveBeenCalled();
	});
});
