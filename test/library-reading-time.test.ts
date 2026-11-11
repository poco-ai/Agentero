// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useLibraryReadingTime } from "@/components/library/hooks/use-library-reading-time";
import { clearUsage } from "@/lib/activity/api";

const mocks = vi.hoisted(() => ({
	clear: vi.fn(),
	load: vi.fn(),
	listen: vi.fn(),
	emit: vi.fn(),
	flush: vi.fn(async () => undefined),
	subscribe: vi.fn(),
}));

vi.mock("@/lib/core/tauri", () => ({ isTauri: () => true }));
vi.mock("@/lib/core/bindings", () => ({
	commands: {
		usageClear: mocks.clear,
		usageReadingDurations: mocks.load,
	},
}));
vi.mock("@tauri-apps/api/event", () => ({
	listen: mocks.listen,
	emit: mocks.emit,
}));
vi.mock("@/lib/activity/track", () => ({
	flushActivity: mocks.flush,
	subscribeReadingDurationChanges: mocks.subscribe,
}));

type Handler = (event: { payload: { vault: string | null } }) => void;
const listeners = new Map<string, Set<Handler>>();
let localRefresh: (() => void) | undefined;
let totals: Record<string, number> | null;
let root: Root;

const initialPapers = [{ path: "papers/a" }];

function Fixture({
	active = true,
	papers = initialPapers,
}: {
	active?: boolean;
	papers?: { path: string }[];
}) {
	totals = useLibraryReadingTime("/vault", active, papers);
	return null;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	listeners.clear();
	localRefresh = undefined;
	mocks.clear.mockResolvedValue({ ok: true, data: 2 });
	mocks.load.mockResolvedValue({ ok: true, data: { "papers/a": 60_000 } });
	mocks.subscribe.mockImplementation((handler: () => void) => {
		localRefresh = handler;
		return () => {
			localRefresh = undefined;
		};
	});
	mocks.listen.mockImplementation(async (name: string, handler: Handler) => {
		const subscribers = listeners.get(name) ?? new Set<Handler>();
		listeners.set(name, subscribers);
		subscribers.add(handler);
		return () => subscribers.delete(handler);
	});
	mocks.emit.mockImplementation(
		async (name: string, payload: { vault: string | null }) => {
			for (const handler of listeners.get(name) ?? []) handler({ payload });
		},
	);
	root = createRoot(document.createElement("div"));
});

afterEach(async () => {
	await act(() => root.unmount());
	vi.unstubAllGlobals();
});

async function mount(active = true) {
	await act(() => root.render(createElement(Fixture, { active })));
}

it("refreshes mounted library totals after a successful clear is broadcast", async () => {
	await mount();
	expect(totals).toEqual({ "papers/a": 60_000 });
	mocks.load.mockResolvedValue({ ok: true, data: {} });
	await act(async () => {
		expect(await clearUsage("/vault")).toBe(2);
	});
	expect(mocks.emit).toHaveBeenCalledWith("activity:usage-cleared", {
		vault: "/vault",
	});
	expect(totals).toEqual({});
});

it("responds to another window's clear only for this vault or all vaults", async () => {
	await mount();
	const initialLoads = mocks.load.mock.calls.length;
	await act(() => mocks.emit("activity:usage-cleared", { vault: "/other" }));
	expect(mocks.load).toHaveBeenCalledTimes(initialLoads);
	mocks.load.mockResolvedValue({ ok: true, data: {} });
	await act(() => mocks.emit("activity:usage-cleared", { vault: null }));
	expect(totals).toEqual({});
	expect(mocks.load).toHaveBeenCalledTimes(initialLoads + 1);
});

it("does not broadcast or refresh when native clearing fails", async () => {
	await mount();
	const initialLoads = mocks.load.mock.calls.length;
	mocks.clear.mockResolvedValue({
		ok: false,
		error: { message: "clear failed" },
	});
	await expect(clearUsage("/vault")).rejects.toThrow("clear failed");
	expect(mocks.emit).not.toHaveBeenCalled();
	expect(mocks.load).toHaveBeenCalledTimes(initialLoads);
	expect(totals).toEqual({ "papers/a": 60_000 });
});

it("does not restore an old total when a pre-clear request resolves late", async () => {
	await mount();
	const stale = Promise.withResolvers<{
		ok: boolean;
		data: Record<string, number>;
	}>();
	mocks.load.mockReturnValueOnce(stale.promise);
	await act(() => localRefresh?.());
	mocks.load.mockResolvedValue({ ok: true, data: {} });
	await act(() => mocks.emit("activity:usage-cleared", { vault: "/vault" }));
	expect(totals).toEqual({});
	await act(async () => {
		stale.resolve({ ok: true, data: { "papers/a": 60_000 } });
	});
	expect(totals).toEqual({});
});

it("preserves successful clearing if the event broadcast fails", async () => {
	mocks.emit.mockRejectedValueOnce(new Error("emit failed"));
	await act(async () => {
		expect(await clearUsage()).toBe(2);
	});
	expect(mocks.emit).toHaveBeenCalledWith("activity:usage-cleared", {
		vault: null,
	});
});

it("retains local persisted-duration refreshes", async () => {
	await mount();
	expect(mocks.flush).toHaveBeenCalledOnce();
	mocks.load.mockResolvedValue({ ok: true, data: { "papers/a": 65_000 } });
	await act(() => localRefresh?.());
	expect(totals).toEqual({ "papers/a": 65_000 });
});

it("unsubscribes inactive libraries and reloads when they become active", async () => {
	await mount();
	await mount(false);
	const initialLoads = mocks.load.mock.calls.length;
	mocks.load.mockResolvedValue({ ok: true, data: {} });
	await act(() => mocks.emit("activity:usage-cleared", { vault: null }));
	expect(mocks.load).toHaveBeenCalledTimes(initialLoads);
	expect(localRefresh).toBeUndefined();
	await mount();
	expect(totals).toEqual({});
});

it("disposes a late subscription without refreshing an unmounted library", async () => {
	const subscription = Promise.withResolvers<() => void>();
	let remoteRefresh: Handler | undefined;
	const off = vi.fn();
	mocks.listen.mockImplementationOnce((_name: string, handler: Handler) => {
		remoteRefresh = handler;
		return subscription.promise;
	});
	await mount();
	await act(() => root.render(null));
	const initialLoads = mocks.load.mock.calls.length;
	await act(async () => {
		remoteRefresh?.({ payload: { vault: null } });
		subscription.resolve(off);
	});
	expect(off).toHaveBeenCalledOnce();
	expect(mocks.load).toHaveBeenCalledTimes(initialLoads);
});

it("keeps the library usable when native event subscription fails", async () => {
	mocks.listen.mockRejectedValueOnce(new Error("listen failed"));
	await mount();
	expect(totals).toEqual({ "papers/a": 60_000 });
	await act(() => root.render(null));
});

it("reloads persisted reading from another window when Library regains focus", async () => {
	await mount();
	mocks.load.mockResolvedValue({ ok: true, data: { "papers/a": 90_000 } });
	await act(() => window.dispatchEvent(new Event("focus")));
	expect(totals).toEqual({ "papers/a": 90_000 });
	await mount(false);
	const loads = mocks.load.mock.calls.length;
	await act(() => window.dispatchEvent(new Event("focus")));
	expect(mocks.load).toHaveBeenCalledTimes(loads);
});

it("follows migrated duration keys after a paper move while Library stays active", async () => {
	await mount();
	mocks.load.mockResolvedValue({
		ok: true,
		data: { "papers/topic/renamed": 60_000 },
	});
	await act(() =>
		root.render(
			createElement(Fixture, { papers: [{ path: "papers/topic/renamed" }] }),
		),
	);
	expect(totals).toEqual({ "papers/topic/renamed": 60_000 });
});
