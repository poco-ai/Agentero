import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import {
	createWritingDocument,
	getWritingText,
	readWritingSnapshot,
} from "@/lib/writing/cloud/protocol/project";
import {
	mergeDiskText,
	patchSharedText,
	reconcileWritingCheckout,
	snapshotProjection,
} from "@/lib/writing/cloud/reconcile";

const remove = vi.hoisted(() => vi.fn(async () => {}));
const writeProjection = vi.hoisted(() => vi.fn(async () => {}));
vi.mock("@tauri-apps/plugin-fs", () => ({ remove, readFile: vi.fn() }));
vi.mock("@/lib/writing/cloud/disk", async (load) => ({
	...(await load<typeof import("@/lib/writing/cloud/disk")>()),
	assertWritingDiskFile: vi.fn(async () => {}),
	ensureWritingDirectory: vi.fn(async () => {}),
	writeProjection,
}));

function fixture() {
	const text = "Alpha \nMiddle\nOmega";
	const doc = createWritingDocument({
		mainFile: "main.tex",
		compiler: "xelatex",
		files: [{ path: "main.tex", kind: "text", text }],
	});
	const fileId = readWritingSnapshot(doc).files[0].id;
	const baseline = snapshotProjection(doc);
	const disk = new Map([
		["main.tex", { path: "main.tex", kind: "text" as const, text }],
	]);
	const onConflicts = vi.fn();
	const reconcile = (canEdit = true) =>
		reconcileWritingCheckout({
			root: "/example/project",
			doc,
			baseline,
			disk,
			canEdit,
			isCurrent: () => true,
			upload: async () => {
				throw new Error("unexpected upload");
			},
			download: async () => {
				throw new Error("unexpected download");
			},
			onConflicts,
		});
	return { doc, disk, fileId, baseline, onConflicts, reconcile };
}

describe("writing disk projection", () => {
	it("combines nonoverlapping local and remote text edits", async () => {
		const { doc, disk, fileId, reconcile } = fixture();
		patchSharedText(getWritingText(doc, fileId), "Alpha \nMiddle\nRemote");
		disk.set("main.tex", {
			path: "main.tex",
			kind: "text",
			text: "Local \nMiddle\nOmega",
		});
		expect(await reconcile()).toBeNull();
		expect(getWritingText(doc, fileId).toString()).toBe(
			"Local \nMiddle\nRemote",
		);
		doc.destroy();
	});

	it("preserves overlapping external text before applying the shared version", async () => {
		writeProjection.mockClear();
		const { doc, disk, fileId, onConflicts, reconcile } = fixture();
		patchSharedText(getWritingText(doc, fileId), "Remote\nMiddle\nOmega");
		disk.set("main.tex", {
			path: "main.tex",
			kind: "text",
			text: "Local\nMiddle\nOmega",
		});
		await reconcile();
		expect(onConflicts).toHaveBeenCalledOnce();
		expect(writeProjection.mock.calls).toHaveLength(2);
		expect(writeProjection).toHaveBeenNthCalledWith(
			1,
			"/example/project",
			expect.stringMatching(/^Agentero Conflicts\//),
			expect.any(Uint8Array),
		);
		expect(writeProjection).toHaveBeenNthCalledWith(
			2,
			"/example/project",
			"main.tex",
			expect.any(Uint8Array),
			disk.get("main.tex"),
		);
		doc.destroy();
	});

	it("projects a read-only checkout without publishing external modifications", async () => {
		const { doc, disk, fileId, onConflicts, reconcile } = fixture();
		disk.set("main.tex", {
			path: "main.tex",
			kind: "text",
			text: "Unshared local copy",
		});
		const version = Y.encodeStateAsUpdate(doc);
		await reconcile(false);
		expect(onConflicts).toHaveBeenCalledOnce();
		expect(Y.encodeStateAsUpdate(doc)).toEqual(version);
		expect(getWritingText(doc, fileId).toString()).toContain("Alpha");
		doc.destroy();
	});

	it("preserves the Yjs file identity across an unambiguous disk rename", async () => {
		const { doc, disk, fileId, reconcile } = fixture();
		const previous = disk.get("main.tex");
		if (!previous) throw new Error("missing fixture file");
		disk.delete("main.tex");
		disk.set("paper.tex", { ...previous, path: "paper.tex" });
		expect(await reconcile()).toBeNull();
		expect(readWritingSnapshot(doc)).toMatchObject({
			mainFileId: fileId,
			files: [{ id: fileId, path: "paper.tex" }],
		});
		doc.destroy();
	});

	it("does not merge two insertions at the same base location", () => {
		expect(mergeDiskText("base", "x-base", "y-base")).toBeNull();
	});
});
