import { beforeEach, expect, it, vi } from "vitest";

/**
 * The magic wand closes its popover as soon as its inputs are queued, so the
 * submit path must not wait for the import itself. Callers that own a
 * per-item spinner (citation cards) still call `lookupSubmit` and get the
 * completion semantics introduced for #434.
 */
const mocks = vi.hoisted(() => ({
	enqueueTask: vi.fn(),
	awaitTaskSettled: vi.fn(),
	notifyError: vi.fn(),
	addPaperSearchDraft: vi.fn(),
	looksLikeTitleSearchQuery: vi.fn((_input: string) => false),
	vaultPath: "/vault" as string | null,
}));

vi.mock("@/i18n", () => ({ default: { t: (key: string) => key } }));
vi.mock("@/lib/activity", () => ({ track: vi.fn() }));
vi.mock("@/lib/core/background-tasks", () => ({
	isBackgroundTaskCancelledError: () => false,
}));
vi.mock("@/lib/core/bindings", () => ({ commands: {} }));
vi.mock("@/lib/core/error", () => ({
	errorText: (error: unknown) => String(error),
}));
vi.mock("@/lib/core/ipc", () => ({ callApiResult: vi.fn() }));
vi.mock("@/lib/core/logger", () => ({
	logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/core/notify", () => ({
	notifyError: mocks.notifyError,
	notifySuccess: vi.fn(),
	notifyWarning: vi.fn(),
}));
vi.mock("@/lib/core/tasks", () => ({
	awaitTaskSettled: mocks.awaitTaskSettled,
	cancelTask: vi.fn(),
	enqueueTask: mocks.enqueueTask,
	enqueueTaskSettled: vi.fn(),
	reportTaskPhase: vi.fn(),
	throwIfTaskCancelled: vi.fn(),
}));
vi.mock("@/lib/paper/library-actions", () => ({
	currentLookupParentDir: () => "papers",
}));
vi.mock("@/lib/paper/library-store", () => ({
	libraryStore: {},
	refreshLibrary: vi.fn(),
	setCitingScanDraft: vi.fn(),
	setLibraryIoBusy: vi.fn(),
}));
vi.mock("@/lib/paper/lookup", () => ({
	addPapersByIdentifiers: vi.fn(),
	discardSkillDiscovery: vi.fn(),
	importLocalPdfs: vi.fn(),
	installDiscoveredSkills: vi.fn(),
	looksLikeTitleSearchQuery: mocks.looksLikeTitleSearchQuery,
}));
vi.mock("@/lib/paper/lookup-diagnostics", () => ({
	formatLookupError: (error: unknown) => String(error),
	lookupDegradedWarning: () => null,
}));
vi.mock("@/lib/pdf/layout", () => ({ enqueuePaperLayoutAnalysis: vi.fn() }));
vi.mock("@/lib/settings/react-store", () => ({ getSettings: () => ({}) }));
vi.mock("@/lib/shell/external-file-drop", () => ({
	cleanupImportTempPaths: vi.fn(),
	isImportTempPath: () => false,
	normalizeDroppedPath: (path: string) => path,
}));
vi.mock("@/lib/shell/ui-store", () => ({
	addPaperSearchDraft: mocks.addPaperSearchDraft,
	bumpLookupOpenSignal: vi.fn(),
	clearPaperSearchDraft: vi.fn(),
	layout: () => undefined,
	setSkillImportDraft: vi.fn(),
	settlePaperSearchDraft: vi.fn(),
	shiftPaperSearchDraft: vi.fn(),
	uiStore: { getState: () => ({ sidebarCollapsed: false }) },
}));
vi.mock("@/lib/vault", () => ({
	joinVaultPath: (...parts: string[]) => parts.join("/"),
}));
vi.mock("@/lib/vault/store", () => ({
	getVaultPath: () => mocks.vaultPath,
	refreshTree: vi.fn(),
}));
vi.mock("@/lib/wiki", () => ({ toVaultRelative: () => "" }));

import { enqueueLookup, lookupSubmit } from "@/lib/paper/import-actions";

function deferred() {
	let resolve!: () => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<void>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.vaultPath = "/vault";
	mocks.looksLikeTitleSearchQuery.mockReturnValue(false);
});

it("resolves at enqueue while the queued job is still running", async () => {
	const settled = deferred();
	mocks.enqueueTask.mockResolvedValue({ id: "job-1" });
	mocks.awaitTaskSettled.mockReturnValue(settled.promise);

	const queue = await enqueueLookup(["1706.03762"]);
	expect(queue.jobIds).toEqual(["job-1"]);
	expect(mocks.enqueueTask).toHaveBeenCalledTimes(1);

	let finished = false;
	void queue.settled.then(() => {
		finished = true;
	});
	await Promise.resolve();
	expect(finished).toBe(false);

	settled.resolve();
	await queue.settled;
	expect(finished).toBe(true);
});

it("queues every input independently so later submits do not wait", async () => {
	const first = deferred();
	const second = deferred();
	mocks.enqueueTask
		.mockResolvedValueOnce({ id: "job-a" })
		.mockResolvedValueOnce({ id: "job-b" })
		.mockResolvedValueOnce({ id: "job-c" });
	mocks.awaitTaskSettled
		.mockReturnValueOnce(first.promise)
		.mockReturnValueOnce(second.promise)
		.mockResolvedValue({ id: "job-c" });

	const batch = await enqueueLookup(["arXiv:1706.03762", "10.1000/x"]);
	expect(batch.jobIds).toEqual(["job-a", "job-b"]);

	// The wand is free again: a second submission queues before the first ends.
	const next = await enqueueLookup(["https://example.org/paper"]);
	expect(next.jobIds).toEqual(["job-c"]);

	first.resolve();
	second.resolve();
	await batch.settled;
	await next.settled;
});

it("keeps lookupSubmit waiting for completion (citation spinners)", async () => {
	const settled = deferred();
	mocks.enqueueTask.mockResolvedValue({ id: "job-2" });
	mocks.awaitTaskSettled.mockReturnValue(settled.promise);

	let finished = false;
	const submitting = lookupSubmit(["1706.03762"]).then(() => {
		finished = true;
	});
	await vi.waitFor(() => expect(mocks.awaitTaskSettled).toHaveBeenCalled());
	expect(finished).toBe(false);

	settled.resolve();
	await submitting;
	expect(finished).toBe(true);
});

it("toasts a failed job without rejecting the queue", async () => {
	mocks.enqueueTask.mockResolvedValue({ id: "job-3" });
	mocks.awaitTaskSettled.mockRejectedValue(new Error("lookup failed"));

	const queue = await enqueueLookup(["10.1000/missing"]);
	await expect(queue.settled).resolves.toBeUndefined();
	expect(mocks.notifyError).toHaveBeenCalledWith(
		"10.1000/missing: Error: lookup failed",
	);
});

it("toasts an enqueue failure and keeps the queue empty", async () => {
	mocks.enqueueTask.mockRejectedValue(new Error("ipc down"));

	const queue = await enqueueLookup(["1706.03762"]);
	expect(queue.jobIds).toEqual([]);
	await expect(queue.settled).resolves.toBeUndefined();
	expect(mocks.notifyError).toHaveBeenCalledWith("1706.03762: Error: ipc down");
});

it("still rejects without a vault so the popover can show it", async () => {
	mocks.vaultPath = null;
	await expect(enqueueLookup(["1706.03762"])).rejects.toThrow(
		"sidebar:lookup.needsVault",
	);
	expect(mocks.enqueueTask).not.toHaveBeenCalled();
});

it("opens the title picker before the enqueue settles", async () => {
	mocks.looksLikeTitleSearchQuery.mockReturnValue(true);
	const settled = deferred();
	mocks.enqueueTask.mockResolvedValue({ id: "job-4" });
	mocks.awaitTaskSettled.mockReturnValue(settled.promise);

	await enqueueLookup(["Attention Is All You Need"]);
	expect(mocks.addPaperSearchDraft).toHaveBeenCalledWith([
		{
			query: "Attention Is All You Need",
			candidates: [],
			parentDir: "papers",
			pending: true,
		},
	]);
	settled.resolve();
});
