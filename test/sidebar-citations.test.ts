import { beforeEach, expect, it, vi } from "vitest";
import { openSidebarCitation } from "@/lib/workspace/sidebar-citations";

const mocks = vi.hoisted(() => ({
	vault: "/vault",
	generation: 0,
	read: vi.fn(async () => ({ pdfBytes: new ArrayBuffer(1) })),
	open: vi.fn(),
	external: vi.fn(),
	notify: vi.fn(),
	jump: vi.fn(),
	resolve: vi.fn(),
}));
vi.mock("@/lib/vault/store", () => ({
	getVaultPath: () => mocks.vault,
	vaultLoadGeneration: () => mocks.generation,
}));
vi.mock("@/lib/agent/api", () => ({ resolvePdfCitation: mocks.resolve }));
vi.mock("@/lib/core/notify", () => ({ notifyError: mocks.notify }));
vi.mock("@/lib/workspace/sidebar-files", async (original) => ({
	...(await original<typeof import("@/lib/workspace/sidebar-files")>()),
	readSidebarFile: mocks.read,
	sidebarPaperPdf: async () => null,
	sidebarPdfPageCount: async () => 10,
}));
vi.mock("@/lib/workspace/viewer-actions", () => ({
	openCitation: mocks.external,
	citationResolveFailedMessage: () => "unresolved citation",
	citationNavigationTarget: (target: { pageIndex: number }) => ({
		page: target.pageIndex + 1,
	}),
}));
vi.mock("@/lib/shell/sidebar-tabs", () => ({
	openOrActivateSidebarTarget: mocks.open,
}));
vi.mock("@/lib/pdf/pending-pdf-page", () => ({
	beginPdfNavigation: (view: string) => view,
	completePdfNavigation: mocks.jump,
}));

beforeEach(() => {
	vi.clearAllMocks();
	mocks.vault = "/vault";
	mocks.generation = 0;
	mocks.open.mockImplementation((_target, options) => {
		if (!options.canOpen()) return Promise.resolve(undefined);
		options.onOpen("view-right-pdf");
		return Promise.resolve("view-right-pdf");
	});
});

it("keeps the last valid click when resolution completes out of order", async () => {
	let finishFirst!: (value: { pageIndex: number }) => void;
	mocks.resolve.mockReturnValueOnce(
		new Promise((resolve) => {
			finishFirst = resolve;
		}),
	);
	mocks.resolve.mockResolvedValueOnce({ pageIndex: 8 });
	const first = openSidebarCitation("papers/paper.pdf#figure=1");
	await openSidebarCitation("papers/paper.pdf#figure=2");
	finishFirst({ pageIndex: 2 });
	await first;
	expect(mocks.jump.mock.calls).toEqual([["view-right-pdf", { page: 9 }]]);
	expect(mocks.open).toHaveBeenCalledOnce();
});

it("drops an in-flight result after a Vault change, even when returning to the same path", async () => {
	let finish!: (value: { pageIndex: number }) => void;
	mocks.resolve.mockReturnValueOnce(
		new Promise((resolve) => {
			finish = resolve;
		}),
	);
	const opening = openSidebarCitation("papers/paper.pdf#figure=1");
	mocks.generation += 2;
	finish({ pageIndex: 2 });
	await opening;
	expect(mocks.open).not.toHaveBeenCalled();
});

it("leaves the active tab unchanged on a denied target and sends web links to the existing opener", async () => {
	mocks.read.mockRejectedValueOnce(new Error("denied"));
	await openSidebarCitation("report.html");
	await openSidebarCitation("https://example.org/page");
	expect(mocks.notify).toHaveBeenCalledWith("denied");
	expect(mocks.open).not.toHaveBeenCalled();
	expect(mocks.external).toHaveBeenCalledWith("https://example.org/page");
});

it("does not activate a tab for an out-of-range page", async () => {
	await openSidebarCitation("paper.pdf#page=11");
	expect(mocks.open).not.toHaveBeenCalled();
	expect(mocks.notify).toHaveBeenCalledWith("unresolved citation");
});
