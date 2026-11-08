// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = vi.hoisted(() => ({ content: "" }));
const read = vi.hoisted(() => vi.fn(async () => disk.content));
const write = vi.hoisted(() =>
	vi.fn(async (_path: string, content: string) => {
		disk.content = content;
	}),
);
const index = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/core/tauri", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/core/tauri")>()),
	isTauri: () => true,
}));
vi.mock("@/lib/vault", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/vault")>()),
	readVaultFile: read,
	writeVaultFile: write,
}));
vi.mock("@/lib/wiki/api", () => ({ applyWikiPaths: index }));
vi.mock("@/lib/core/notify", () => ({
	notifyError: vi.fn(),
	notifyReminder: vi.fn(),
	notifyUndo: vi.fn(),
	notifyWarning: vi.fn(),
}));

import { notifyError, notifyReminder } from "@/lib/core/notify";
import { vaultStore } from "@/lib/vault/store";
import { clearWikiVaultState } from "@/lib/wiki/store";
import { applyDiskChange, persistFile } from "@/lib/workspace/persistence";
import { getTabs, setTabs, workspaceStore } from "@/lib/workspace/store";
import { createPlaceholderTab, type DocTab } from "@/lib/workspace/tabs";

const SEED = "# Note\n\nFirst paragraph.\n\nLast paragraph.\n";
const FIRST = SEED.replace("First", "Changed first");
const SECOND = SEED.replace("Last", "Changed last");
let sequence = 0;
let path: string;

function panels(notes: boolean, siblingDirty: boolean): [DocTab, DocTab] {
	if (notes) path = path.replace(/note\.md$/, "papers/p1/NOTES.md");
	const base = {
		...createPlaceholderTab(path, "markdown"),
		loaded: true,
		...(notes ? { notesPath: path, notesSeed: SEED } : { markdownSeed: SEED }),
	};
	const dirty = notes ? "notesDirty" : "markdownDirty";
	const first = { ...base, [dirty]: true };
	const second = { ...base, id: `${base.id}::pane-2`, [dirty]: siblingDirty };
	workspaceStore.setState({ tabs: [first, second] });
	return [first, second];
}

function reminder() {
	const calls = vi.mocked(notifyReminder).mock.calls;
	return calls[calls.length - 1][1];
}

describe("Markdown split-panel persistence", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearWikiVaultState();
		path = `/vault/split-${sequence++}/note.md`;
		disk.content = SEED;
		vaultStore.setState({ vaultPath: "/vault" });
		workspaceStore.setState({ tabs: [] });
	});

	it.each([
		false,
		true,
	])("reloads clean siblings without reloading the writer (notes=%s)", async (notes) => {
		const [first] = panels(notes, false);
		const seed = notes ? "notesSeed" : "markdownSeed";
		const key = notes ? "notesKey" : "seedKey";
		if (notes) {
			setTabs((prev) => [
				...prev,
				{
					...createPlaceholderTab(path.replace("NOTES.md", "paper.pdf"), "pdf"),
					notesPath: path,
					notesSeed: SEED,
				},
			]);
		}

		expect(await persistFile(path, FIRST, SEED, first.id)).toBe(true);
		expect(getTabs()[0]).toMatchObject({ [seed]: FIRST, [key]: 0 });
		expect(getTabs()[1]).toMatchObject({ [seed]: FIRST, [key]: 1 });
		if (notes)
			expect(getTabs()[2]).toMatchObject({ notesSeed: FIRST, notesKey: 0 });
		expect(notifyReminder).not.toHaveBeenCalled();
		// The watcher echo must neither reload the writer nor reload its sibling twice.
		await applyDiskChange(path);
		expect(getTabs()[0][key]).toBe(0);
		expect(getTabs()[1][key]).toBe(1);
	});

	it.each([
		false,
		true,
	])("retains dirty sibling drafts and blocks every save until an explicit reload (notes=%s)", async (notes) => {
		const [first, second] = panels(notes, true);
		const seed = notes ? "notesSeed" : "markdownSeed";
		const key = notes ? "notesKey" : "seedKey";
		const dirty = notes ? "notesDirty" : "markdownDirty";

		await persistFile(path, FIRST, SEED, first.id);
		expect(getTabs()[1]).toMatchObject({
			[seed]: SEED,
			[key]: 0,
			[dirty]: true,
			markdownConflict: true,
		});
		expect(notifyReminder).toHaveBeenCalledTimes(1);
		// The toast only offers the disk reload; the banner owns "keep draft".
		expect(reminder().dismissLabel).toBeUndefined();
		expect(await persistFile(path, SECOND, SEED, second.id)).toBe(false);
		// Even a caller with an advanced snapshot cannot bypass an unresolved conflict.
		expect(await persistFile(path, SECOND, FIRST, second.id)).toBe(false);
		expect(disk.content).toBe(FIRST);
		expect(write).toHaveBeenCalledTimes(1);

		// The prompt may outlive another successful save. Load the current disk bytes.
		await persistFile(path, `${FIRST}Newer.\n`, FIRST, first.id);
		const writer = getTabs()[0];
		reminder().onAction();
		await vi.waitFor(() => expect(getTabs()[1].markdownConflict).toBe(false));
		expect(getTabs()[0]).toBe(writer);
		expect(getTabs()[1]).toMatchObject({
			[seed]: disk.content,
			[key]: 1,
			[dirty]: false,
		});
		expect(
			await persistFile(
				path,
				`${disk.content}Resolved.\n`,
				disk.content,
				second.id,
			),
		).toBe(true);
	});

	it("serializes simultaneous saves so only the first panel can write its stale baseline", async () => {
		const [first, second] = panels(false, true);
		expect(
			await Promise.all([
				persistFile(path, FIRST, SEED, first.id),
				persistFile(path, SECOND, SEED, second.id),
			]),
		).toEqual([true, false]);
		expect(disk.content).toBe(FIRST);
		expect(write).toHaveBeenCalledTimes(1);
	});

	it("marks siblings before wiki indexing finishes and permits only the same writer to catch up", async () => {
		const [first, second] = panels(false, true);
		let release = () => {};
		index.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
				}),
		);
		const saving = persistFile(path, FIRST, SEED, first.id);
		await vi.waitFor(() => expect(index).toHaveBeenCalledTimes(1));
		expect(getTabs()[1].markdownConflict).toBe(true);
		await applyDiskChange(path);
		expect(getTabs()[0].seedKey).toBe(0);
		const staleSibling = persistFile(path, SECOND, SEED, second.id);
		const queuedWriter = persistFile(path, `${FIRST}Typing.\n`, SEED, first.id);
		release();
		expect(await Promise.all([saving, staleSibling, queuedWriter])).toEqual([
			true,
			false,
			true,
		]);
		expect(disk.content).toBe(`${FIRST}Typing.\n`);
	});

	it("rejects stale writes from a panel absent from the tab snapshot", async () => {
		const [first] = panels(false, false);
		await persistFile(path, FIRST, SEED, first.id);
		expect(await persistFile(path, SECOND, SEED, "unmounted-panel")).toBe(
			false,
		);
		expect(disk.content).toBe(FIRST);
	});

	it("keeps the conflict and draft when loading the disk version fails", async () => {
		const [first] = panels(false, true);
		await persistFile(path, FIRST, SEED, first.id);
		const conflicted = getTabs()[1];
		read.mockRejectedValueOnce(new Error("Cannot read file"));
		reminder().onAction();
		await vi.waitFor(() => expect(notifyError).toHaveBeenCalled());
		expect(getTabs()[1]).toBe(conflicted);
		expect(write).toHaveBeenCalledTimes(1);
	});
});
