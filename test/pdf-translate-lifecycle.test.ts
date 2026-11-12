import { beforeEach, describe, expect, it, vi } from "vitest";
import { mergeTranslateRefresh } from "@/components/viewer/pdf/hooks/use-pdf-marks-io";
import { usePdfSelectionTranslate } from "@/components/viewer/pdf/hooks/use-pdf-selection-translate";
import { createTranslateRecord } from "@/lib/pdf/translate/io";
import type { RunSelectionTranslateOptions } from "@/lib/pdf/translate/run-selection";
import { parsePdfTranslateRecord } from "@/lib/pdf/translate/schema";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";

const mocks = vi.hoisted(() => ({
	write: vi.fn<(...args: unknown[]) => Promise<void>>(),
	remove: vi.fn<(...args: unknown[]) => Promise<void>>(),
	run: vi.fn<(options: RunSelectionTranslateOptions) => Promise<void>>(),
	notify: vi.fn(),
	cancel: vi.fn(),
	cleanups: [] as (() => void)[],
}));

// Exercise the hook's callbacks and teardown without requiring a DOM renderer.
vi.mock("react", async (importOriginal) => ({
	...(await importOriginal<typeof import("react")>()),
	useCallback: (callback: unknown) => callback,
	useRef: (value: unknown) => ({ current: value }),
	useState: (value: unknown) => [value, vi.fn()],
	useEffect: (effect: () => (() => void) | undefined) => {
		const cleanup = effect();
		if (cleanup) mocks.cleanups.push(cleanup);
	},
}));
vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: mocks.notify }));
vi.mock("@/lib/agent", () => ({
	cancelAgentRun: mocks.cancel,
	disposeAgentRun: ({ disposedRef }: { disposedRef: { current: boolean } }) => {
		disposedRef.current = true;
	},
}));
vi.mock("@/lib/pdf/translate", async (importOriginal) => ({
	...(await importOriginal<typeof import("@/lib/pdf/translate")>()),
	writePdfTranslate: mocks.write,
	deletePdfTranslate: mocks.remove,
	runSelectionTranslate: mocks.run,
}));

function record(id: string): PdfTranslateRecord {
	return createTranslateRecord({
		id,
		paperPath: "papers/test",
		page: 1,
		rects: [{ x: 0.1, y: 0.2, w: 0.3, h: 0.04 }],
		result: "translation",
	});
}

function harness() {
	const records = { current: [] as PdfTranslateRecord[] };
	const protectedIds = { current: new Set<string>() };
	// biome-ignore lint/correctness/useHookAtTopLevel: React hooks are mocked to exercise callback logic without mounting.
	const hook = usePdfSelectionTranslate({
		isActive: true,
		paperAbsPath: "D:/vault/papers/test",
		paperRelPath: "papers/test",
		vaultPath: "D:/vault",
		onOpenSettings: undefined,
		translatesRef: records,
		protectedTranslateIdsRef: protectedIds,
		setTranslates: (next) => {
			records.current =
				typeof next === "function" ? next(records.current) : next;
		},
		upsertTranslate: (next, { preservePinned = true } = {}) => {
			const previous = records.current.find((item) => item.id === next.id);
			const merged = {
				...next,
				pinned: preservePinned
					? (previous?.pinned ?? next.pinned)
					: next.pinned,
			};
			records.current = [
				merged,
				...records.current.filter((item) => item.id !== next.id),
			];
			return merged;
		},
		openCard: vi.fn(),
		activeSessionRef: { current: null },
	});
	const start = () => {
		hook.translateSelection({
			page: 1,
			rects: record("anchor").rects,
			quote: "source",
			trigger: "selection",
		});
		const run = mocks.run.mock.calls.at(-1)?.[0];
		if (!run) throw new Error("Translation did not start");
		return run;
	};
	return { hook, records, protectedIds, start };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.cleanups.length = 0;
	mocks.write.mockResolvedValue();
	mocks.remove.mockResolvedValue();
	mocks.run.mockResolvedValue();
	mocks.cancel.mockResolvedValue(undefined);
});

describe("translation compatibility and refresh", () => {
	it("creates a translation with every selected page before opening its result card", () => {
		const h = harness();
		const rects = record("anchor").rects;
		const selectionPages = [
			{ page: 1, rects },
			{ page: 2, rects },
		];
		h.hook.translateSelection({
			page: 2,
			rects,
			quote: "cross-page source",
			trigger: "selection",
			selectionPages,
		});
		expect(h.records.current[0].page).toBe(2);
		expect(h.records.current[0].selectionPages).toEqual(selectionPages);
	});
	it("keeps legacy records reachable while respecting explicit unpin", () => {
		const { pinned: _, ...legacy } = record("old");
		expect(parsePdfTranslateRecord(legacy)?.pinned).toBe(true);
		expect(parsePdfTranslateRecord({ ...legacy, pinned: false })?.pinned).toBe(
			false,
		);
		expect(record("new").pinned).toBe(false);
	});

	it("preserves streams and pending pins while accepting unrelated disk updates", () => {
		const local = { ...record("live"), result: "streaming", pinned: true };
		const external = record("external");
		expect(
			mergeTranslateRefresh(
				[local],
				[record("live"), external],
				new Set(["live"]),
			),
		).toEqual([local, external]);
	});

	it("does not resurrect a pending deletion", () => {
		expect(
			mergeTranslateRefresh([], [record("removed")], new Set(["removed"])),
		).toEqual([]);
	});

	it("ignores snapshots that predate a local change or deletion", () => {
		const original = record("edited");
		const removed = record("removed");
		const updated = { ...original, pinned: true };
		expect(
			mergeTranslateRefresh([updated], [original, removed], new Set(), [
				original,
				removed,
			]),
		).toEqual([updated]);
	});

	it("accepts external deletion once a record is no longer protected", () => {
		expect(mergeTranslateRefresh([record("saved")], [], new Set())).toEqual([]);
	});
});

describe("translation retention lifecycle", () => {
	it("invalidates a superseded request before its late callbacks or agent attachment", () => {
		const h = harness();
		const previous = h.start();
		const current = h.start();
		expect(previous.disposedRef.current).toBe(true);
		expect(current.disposedRef.current).toBe(false);
		previous.commitProviderResult("old result");
		current.commitProviderResult("new result");
		expect(h.records.current[0].result).toBe("new result");
		expect(
			h.records.current.some((entry) => entry.result === "old result"),
		).toBe(false);
	});

	it("keeps a pinned result across dismissal and streaming completion", async () => {
		const h = harness();
		const run = h.start();
		const initial = h.records.current[0];
		h.hook.toggleTranslatePin(initial);
		h.hook.discardUnpinnedTranslateOnClose(initial.id);
		run.appendChunk("chunk");
		run.commitProviderResult("completed");
		await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledTimes(2));
		expect(h.records.current[0]).toMatchObject({
			pinned: true,
			result: "completed",
		});
		expect(mocks.remove).not.toHaveBeenCalled();
		await vi.waitFor(() => expect(h.protectedIds.current.size).toBe(0));
	});

	it("keeps an unpinned card readable until dismissal and rejects late results", async () => {
		const h = harness();
		const run = h.start();
		const initial = h.records.current[0];
		h.hook.toggleTranslatePin(initial);
		h.hook.toggleTranslatePin(h.records.current[0]);
		expect(h.records.current).toHaveLength(1);
		h.hook.discardUnpinnedTranslateOnClose(initial.id);
		run.appendChunk("late chunk");
		run.commitProviderResult("late result");
		expect(h.records.current).toEqual([]);
		await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce());
		expect(mocks.write).toHaveBeenCalledTimes(2);
	});

	it("waits for an in-flight save before deleting and prevents stale refresh resurrection", async () => {
		let finish!: () => void;
		mocks.write.mockImplementationOnce(
			() =>
				new Promise<void>((resolve) => {
					finish = resolve;
				}),
		);
		const h = harness();
		h.start().commitProviderResult("completed");
		await vi.waitFor(() => expect(mocks.write).toHaveBeenCalledOnce());
		const saved = h.records.current[0];
		h.hook.discardUnpinnedTranslateOnClose(saved.id);
		expect(
			mergeTranslateRefresh(h.records.current, [saved], h.protectedIds.current),
		).toEqual([]);
		expect(mocks.remove).not.toHaveBeenCalled();
		finish();
		await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce());
	});

	it("reports a failed save and protects the readable result from refresh", async () => {
		mocks.write.mockRejectedValueOnce(new Error("disk full"));
		const h = harness();
		h.start().commitProviderResult("completed");
		await vi.waitFor(() =>
			expect(mocks.notify).toHaveBeenCalledWith(
				"selection.translateUpdateFailed",
				{ description: "disk full" },
			),
		);
		expect(
			mergeTranslateRefresh(h.records.current, [], h.protectedIds.current),
		).toEqual(h.records.current);
	});

	it("reports a failed removal without restoring the discarded card", async () => {
		mocks.remove.mockRejectedValueOnce(new Error("permission denied"));
		const h = harness();
		h.start();
		const initial = h.records.current[0];
		h.hook.discardUnpinnedTranslateOnClose(initial.id);
		await vi.waitFor(() => expect(mocks.notify).toHaveBeenCalled());
		expect(
			mergeTranslateRefresh([], [initial], h.protectedIds.current),
		).toEqual([]);
	});

	it("removes temporary results on viewer teardown and ignores late completion", async () => {
		const h = harness();
		const run = h.start();
		mocks.cleanups[0]();
		run.commitProviderResult("late result");
		await vi.waitFor(() => expect(mocks.remove).toHaveBeenCalledOnce());
		expect(mocks.write).not.toHaveBeenCalled();
	});
});
