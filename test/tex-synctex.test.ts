import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	forward: vi.fn(),
	artifacts: vi.fn(),
	resolve: vi.fn(),
	open: vi.fn(),
	update: vi.fn(),
	notify: vi.fn(),
	cursor: vi.fn(),
	activeTabId: null as string | null,
	tabs: [] as {
		id: string;
		path: string;
		mode: string;
		texRoot?: string;
		texLive?: boolean;
		pdfBytes?: ArrayBuffer;
	}[],
}));
vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/core/notify", () => ({ notifyError: mocks.notify }));
vi.mock("@/lib/tex/host", () => ({
	syncTexForward: mocks.forward,
	getLatexArtifacts: mocks.artifacts,
}));
vi.mock("@/lib/tex/config", () => ({
	texBuildOptions: () => ({ outDir: "build", jobname: "paper" }),
}));
vi.mock("@/lib/tex/editor-navigation", () => ({
	getTexEditorCursor: mocks.cursor,
}));
vi.mock("@/lib/workspace/tex-compile", () => ({
	resolveTexRoot: mocks.resolve,
}));
vi.mock("@/lib/workspace/navigation", () => ({ openTab: mocks.open }));
vi.mock("@/lib/workspace/store", () => ({
	workspaceStore: {
		getState: () => ({ tabs: mocks.tabs, activeTabId: mocks.activeTabId }),
	},
	updateTab: mocks.update,
}));
vi.mock("@/lib/workspace/tabs", () => ({
	tabIdForPath: (path: string) => path,
}));

import { embedPdfDocumentId } from "@/lib/pdf/document-id";
import {
	registerTexPdfViewer,
	syncTexAfterBuild,
	syncTexToPdf,
} from "@/lib/tex/synctex";

const location = { page: 3, x: 80, y: 200, width: 340, height: 12 };
beforeEach(() => {
	vi.clearAllMocks();
	mocks.tabs = [];
	mocks.activeTabId = null;
	mocks.resolve.mockResolvedValue("/vault/thesis/main.tex");
	mocks.artifacts.mockResolvedValue({
		pdfPath: "/vault/thesis/build/paper.pdf",
	});
	mocks.forward.mockResolvedValue([location]);
	mocks.cursor.mockReturnValue({
		path: "/vault/thesis/chapter.tex",
		line: 12,
		column: 7,
	});
});

describe("compiled PDF SyncTeX routing", () => {
	it("keeps source-to-PDF navigation inside the active project preview", async () => {
		const navigate = vi.fn();
		const off = registerTexPdfViewer("/vault/thesis/build/paper.pdf", {
			tabId: "project-source",
			scope: "writing",
			navigate,
			isActive: () => true,
		});
		try {
			await syncTexToPdf("/vault/thesis/chapter.tex", 12, 7);
			expect(navigate).toHaveBeenCalledExactlyOnceWith(location);
			expect(mocks.open).not.toHaveBeenCalled();
			expect(mocks.update).not.toHaveBeenCalled();
		} finally {
			off();
		}
	});

	it("uses the actual configured output and queues a location until the PDF mounts", async () => {
		await syncTexToPdf("/vault/thesis/chapter.tex", 12, 7);
		expect(mocks.artifacts).toHaveBeenCalledWith("/vault/thesis/main.tex", {
			outDir: "build",
			jobname: "paper",
		});
		expect(mocks.forward).toHaveBeenCalledWith(
			"/vault/thesis/build/paper.pdf",
			"/vault/thesis/chapter.tex",
			12,
			7,
		);
		const navigate = vi.fn();
		const off = registerTexPdfViewer("/vault/thesis/build/paper.pdf", {
			tabId: "/vault/thesis/build/paper.pdf",
			navigate,
			isActive: () => true,
		});
		expect(navigate).toHaveBeenCalledExactlyOnceWith(location);
		off();
	});

	it("routes an explicit locate to its activated pane despite stale clone focus", async () => {
		mocks.artifacts.mockResolvedValue({ pdfPath: "/vault/thesis/split.pdf" });
		const canonical = vi.fn();
		const staleActiveClone = vi.fn();
		const off1 = registerTexPdfViewer("/vault/thesis/split.pdf", {
			tabId: "/vault/thesis/split.pdf",
			navigate: canonical,
			isActive: () => false,
		});
		const off2 = registerTexPdfViewer("/vault/thesis/split.pdf", {
			tabId: "/vault/thesis/split.pdf::pane-2",
			navigate: staleActiveClone,
			isActive: () => true,
		});
		await syncTexToPdf("/vault/thesis/chapter.tex", 12);
		expect(canonical).toHaveBeenCalledExactlyOnceWith(location);
		expect(staleActiveClone).not.toHaveBeenCalled();
		off1();
		off2();
	});

	it("does not open, activate, or query a PDF when after-build following is disabled", async () => {
		await syncTexAfterBuild(
			"/vault/disabled/main.tex",
			"/vault/disabled/main.pdf",
			false,
		);
		expect(mocks.forward).not.toHaveBeenCalled();
		expect(mocks.open).not.toHaveBeenCalled();
	});

	it("keeps after-build following in the current project and never steals focus", async () => {
		const navigate = vi.fn();
		const off = registerTexPdfViewer("/vault/follow/main.pdf", {
			navigate,
			isActive: () => false,
		});
		await syncTexAfterBuild(
			"/vault/thesis/main.tex",
			"/vault/follow/main.pdf",
			true,
		);
		expect(navigate).toHaveBeenCalledWith(location);
		expect(mocks.open).not.toHaveBeenCalled();
		mocks.resolve.mockResolvedValue("/vault/other/main.tex");
		await syncTexAfterBuild(
			"/vault/thesis/main.tex",
			"/vault/follow/main.pdf",
			true,
		);
		expect(mocks.forward).toHaveBeenCalledTimes(1);
		off();
	});

	it("ignores an older source lookup that finishes after a newer request", async () => {
		mocks.artifacts.mockResolvedValue({ pdfPath: "/vault/thesis/stale.pdf" });
		let finishFirst!: (value: (typeof location)[]) => void;
		mocks.forward.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finishFirst = resolve;
				}),
		);
		const first = syncTexToPdf("/vault/thesis/chapter.tex", 12);
		await vi.waitFor(() => expect(mocks.forward).toHaveBeenCalledTimes(1));
		await syncTexToPdf("/vault/thesis/chapter.tex", 24);
		finishFirst([{ ...location, page: 1 }]);
		await first;
		expect(mocks.open).toHaveBeenCalledTimes(1);
		const navigate = vi.fn();
		const off = registerTexPdfViewer("/vault/thesis/stale.pdf", {
			tabId: "/vault/thesis/stale.pdf",
			navigate,
			isActive: () => true,
		});
		expect(navigate).toHaveBeenCalledExactlyOnceWith(location);
		off();
	});

	it("waits for the fresh buffer revision before following a completed build", async () => {
		const pdfPath = "/vault/revision/main.pdf";
		const bytes = new ArrayBuffer(64);
		mocks.tabs = [{ id: pdfPath, path: pdfPath, mode: "pdf", pdfBytes: bytes }];
		const oldNavigate = vi.fn();
		const offOld = registerTexPdfViewer(pdfPath, {
			tabId: pdfPath,
			documentId: "old-revision",
			navigate: oldNavigate,
			isActive: () => true,
		});
		await syncTexAfterBuild("/vault/thesis/main.tex", pdfPath, true);
		expect(oldNavigate).not.toHaveBeenCalled();
		const newNavigate = vi.fn();
		const offNew = registerTexPdfViewer(pdfPath, {
			tabId: pdfPath,
			documentId: embedPdfDocumentId(pdfPath, bytes),
			navigate: newNavigate,
			isActive: () => true,
		});
		expect(newNavigate).toHaveBeenCalledExactlyOnceWith(location);
		offOld();
		offNew();
	});

	it("uses the new configured output when older PDFs from the same root stay open", async () => {
		mocks.tabs = [
			{
				id: "/vault/thesis/main.pdf",
				path: "/vault/thesis/main.pdf",
				mode: "pdf",
				texRoot: "/vault/thesis/main.tex",
			},
			{
				id: "/vault/thesis/build/paper.pdf",
				path: "/vault/thesis/build/paper.pdf",
				mode: "pdf",
				texRoot: "/vault/thesis/main.tex",
			},
		];
		await syncTexToPdf("/vault/thesis/chapter.tex", 12);
		expect(mocks.forward).toHaveBeenCalledWith(
			"/vault/thesis/build/paper.pdf",
			"/vault/thesis/chapter.tex",
			12,
			1,
		);
	});

	it("follows the active clone after its own fresh buffer layout mounts", async () => {
		const pdfPath = "/vault/clone/main.pdf";
		const cloneId = `${pdfPath}::pane-2`;
		const canonicalBytes = new ArrayBuffer(32);
		const cloneBytes = new ArrayBuffer(64);
		mocks.tabs = [
			{ id: pdfPath, path: pdfPath, mode: "pdf", pdfBytes: canonicalBytes },
			{ id: cloneId, path: pdfPath, mode: "pdf", pdfBytes: cloneBytes },
		];
		mocks.activeTabId = cloneId;
		const canonicalNavigate = vi.fn();
		const staleCloneNavigate = vi.fn();
		const offCanonical = registerTexPdfViewer(pdfPath, {
			tabId: pdfPath,
			documentId: embedPdfDocumentId(pdfPath, canonicalBytes),
			navigate: canonicalNavigate,
			isActive: () => false,
		});
		const offStaleClone = registerTexPdfViewer(pdfPath, {
			tabId: cloneId,
			documentId: "old-clone",
			navigate: staleCloneNavigate,
			isActive: () => true,
		});
		await syncTexAfterBuild("/vault/thesis/main.tex", pdfPath, true);
		expect(canonicalNavigate).not.toHaveBeenCalled();
		expect(staleCloneNavigate).not.toHaveBeenCalled();
		const cloneNavigate = vi.fn();
		const offClone = registerTexPdfViewer(pdfPath, {
			tabId: cloneId,
			documentId: embedPdfDocumentId(cloneId, cloneBytes),
			navigate: cloneNavigate,
			isActive: () => true,
		});
		expect(cloneNavigate).toHaveBeenCalledExactlyOnceWith(location);
		offCanonical();
		offStaleClone();
		offClone();
	});

	it("waits for the activated canonical pane's exact revision during an explicit locate", async () => {
		const pdfPath = "/vault/explicit/main.pdf";
		const bytes = new ArrayBuffer(96);
		const cloneId = `${pdfPath}::pane-2`;
		mocks.artifacts.mockResolvedValue({ pdfPath });
		mocks.tabs = [
			{ id: pdfPath, path: pdfPath, mode: "pdf", pdfBytes: bytes },
			{
				id: cloneId,
				path: pdfPath,
				mode: "pdf",
				pdfBytes: new ArrayBuffer(32),
			},
		];
		mocks.activeTabId = "/vault/thesis/chapter.tex";
		mocks.open.mockImplementationOnce(() => {
			mocks.activeTabId = pdfPath;
		});
		const oldCanonical = vi.fn();
		const inactiveClone = vi.fn();
		const offOld = registerTexPdfViewer(pdfPath, {
			tabId: pdfPath,
			documentId: "old-canonical",
			navigate: oldCanonical,
			isActive: () => false,
		});
		const offClone = registerTexPdfViewer(pdfPath, {
			tabId: cloneId,
			navigate: inactiveClone,
			isActive: () => false,
		});
		await syncTexToPdf("/vault/thesis/chapter.tex", 12);
		expect(oldCanonical).not.toHaveBeenCalled();
		expect(inactiveClone).not.toHaveBeenCalled();
		const canonical = vi.fn();
		const offCurrent = registerTexPdfViewer(pdfPath, {
			tabId: pdfPath,
			documentId: embedPdfDocumentId(pdfPath, bytes),
			navigate: canonical,
			isActive: () => true,
		});
		expect(canonical).toHaveBeenCalledExactlyOnceWith(location);
		offOld();
		offClone();
		offCurrent();
	});
});
