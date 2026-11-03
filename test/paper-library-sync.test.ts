import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	closeTabsUnderPath,
	remapMovedWorkspacePaths,
	scheduleTreeRefresh,
	setTreeSelectedPath,
	vaultPathExists,
} = vi.hoisted(() => ({
	closeTabsUnderPath: vi.fn(),
	remapMovedWorkspacePaths: vi.fn(),
	scheduleTreeRefresh: vi.fn(),
	setTreeSelectedPath: vi.fn(),
	vaultPathExists: vi.fn(async () => false),
}));

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/vault/store", () => ({
	getVaultPath: () => "/vault",
	scheduleTreeRefresh,
	setTreeSelectedPath,
}));
vi.mock("@/lib/vault/fs", () => ({ vaultPathExists }));
vi.mock("@/lib/workspace/navigation", () => ({
	closeTabsUnderPath,
	remapMovedWorkspacePaths,
}));

import {
	planPaperPathChanges,
	reconcileExternalLibraryChange,
} from "@/lib/paper/library-sync";
import type { PaperLibraryRow } from "@/lib/paper/types";

function row(id: string, path: string): PaperLibraryRow {
	return { id, path } as PaperLibraryRow;
}

beforeEach(() => {
	closeTabsUnderPath.mockClear();
	remapMovedWorkspacePaths.mockClear();
	scheduleTreeRefresh.mockClear();
	setTreeSelectedPath.mockClear();
	vaultPathExists.mockReset();
	vaultPathExists.mockResolvedValue(false);
});

describe("planPaperPathChanges", () => {
	it("pairs a move by paper id", () => {
		const plan = planPaperPathChanges(
			[row("p1", "papers/inbox/demo")],
			[row("p1", "papers/archive/demo")],
		);
		expect(plan.moves).toEqual([
			{ id: "p1", fromRel: "papers/inbox/demo", toRel: "papers/archive/demo" },
		]);
		expect(plan.removals).toEqual([]);
	});

	it("treats a vanished id as a removal", () => {
		const plan = planPaperPathChanges([row("p1", "papers/inbox/demo")], []);
		expect(plan.moves).toEqual([]);
		expect(plan.removals).toEqual([{ id: "p1", rel: "papers/inbox/demo" }]);
	});

	it("does not remove a path still occupied by another row", () => {
		const plan = planPaperPathChanges(
			[row("p1", "papers/inbox/demo")],
			[row("p2", "papers/inbox/demo")],
		);
		expect(plan.removals).toEqual([]);
	});

	it("normalizes separators before comparing paths", () => {
		const plan = planPaperPathChanges(
			[row("p1", "papers\\inbox\\demo")],
			[row("p1", "/papers/inbox/demo/")],
		);
		expect(plan.moves).toEqual([]);
		expect(plan.removals).toEqual([]);
	});
});

describe("reconcileExternalLibraryChange", () => {
	it("remaps workspace paths across a same-vault move", async () => {
		await reconcileExternalLibraryChange(
			"/vault",
			[row("p1", "papers/inbox/demo")],
			[row("p1", "papers/archive/demo")],
		);

		expect(remapMovedWorkspacePaths).toHaveBeenCalledWith(
			"/vault/papers/inbox/demo",
			"/vault/papers/archive/demo",
			"papers/inbox/demo",
			"papers/archive/demo",
		);
		expect(closeTabsUnderPath).not.toHaveBeenCalled();
		expect(scheduleTreeRefresh).toHaveBeenCalledWith([
			"/vault/papers/inbox/demo",
			"/vault/papers/archive/demo",
		]);
	});

	it("closes tabs and tree selection for a paper that left the vault", async () => {
		await reconcileExternalLibraryChange(
			"/vault",
			[row("p1", "papers/demo")],
			[],
		);

		expect(closeTabsUnderPath).toHaveBeenCalledWith("/vault/papers/demo");
		expect(setTreeSelectedPath).toHaveBeenCalledTimes(1);
		expect(scheduleTreeRefresh).toHaveBeenCalledWith(["/vault/papers/demo"]);
	});

	it("keeps state when the catalog dropped the row but the folder remains", async () => {
		vaultPathExists.mockResolvedValue(true);

		await reconcileExternalLibraryChange(
			"/vault",
			[row("p1", "papers/demo")],
			[],
		);

		expect(closeTabsUnderPath).not.toHaveBeenCalled();
		expect(setTreeSelectedPath).not.toHaveBeenCalled();
	});

	it("ignores snapshots with no previous rows", async () => {
		await reconcileExternalLibraryChange(
			"/vault",
			[],
			[row("p1", "papers/demo")],
		);

		expect(remapMovedWorkspacePaths).not.toHaveBeenCalled();
		expect(scheduleTreeRefresh).not.toHaveBeenCalled();
	});
});
