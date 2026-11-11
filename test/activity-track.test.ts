import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/core/tauri", () => ({
	isTauri: () => true,
}));

const vaultState = vi.hoisted(() => ({ path: "/Users/me/vault" }));

vi.mock("@/lib/vault/store", () => ({
	getVaultPath: () => vaultState.path,
}));

const recordActivityEvents = vi.fn(async (events: unknown[]) => events.length);

vi.mock("@/lib/activity/api", () => ({
	recordActivityEvents: (events: unknown[]) => recordActivityEvents(events),
}));

import {
	flushActivity,
	notePaperFocus,
	pendingActivityCountForTests,
	resetActivityBufferForTests,
	startActivityTracking,
	track,
} from "@/lib/activity/track";

describe("activity track", () => {
	beforeEach(() => {
		vaultState.path = "/Users/me/vault";
		resetActivityBufferForTests();
		recordActivityEvents.mockClear();
	});

	afterEach(() => {
		resetActivityBufferForTests();
	});

	it("buffers known kinds and stores vault-relative paths", async () => {
		track("paper.open", {
			path: "/Users/me/vault/papers/demo",
			mode: "pdf",
		});
		expect(pendingActivityCountForTests()).toBe(1);
		await flushActivity();
		expect(recordActivityEvents).toHaveBeenCalledTimes(1);
		const batch = recordActivityEvents.mock.calls[0]?.[0] as Array<{
			kind: string;
			path?: string;
			mode?: string;
			vault?: string;
		}>;
		expect(batch[0]?.kind).toBe("paper.open");
		expect(batch[0]?.path).toBe("papers/demo");
		expect(batch[0]?.mode).toBe("pdf");
		expect(batch[0]?.vault).toBe("/Users/me/vault");
	});

	it("dedupes the same kind+path within 1s", () => {
		track("paper.open", { path: "papers/demo", mode: "pdf" });
		track("paper.open", { path: "papers/demo", mode: "pdf" });
		expect(pendingActivityCountForTests()).toBe(1);
	});

	it("ignores unknown kinds", () => {
		track("not.a.kind");
		expect(pendingActivityCountForTests()).toBe(0);
	});
});

describe("foreground paper reading time", () => {
	let windowEvents: EventTarget;
	let documentEvents: EventTarget;
	let visible: boolean;
	let foreground: boolean;
	let stop: () => void;

	beforeEach(() => {
		vaultState.path = "/Users/me/vault";
		vi.useFakeTimers();
		resetActivityBufferForTests();
		recordActivityEvents.mockClear();
		visible = true;
		foreground = true;
		windowEvents = new EventTarget();
		documentEvents = new EventTarget();
		Object.defineProperties(documentEvents, {
			visibilityState: { get: () => (visible ? "visible" : "hidden") },
			hasFocus: { value: () => foreground },
		});
		vi.stubGlobal("window", windowEvents);
		vi.stubGlobal("document", documentEvents);
		stop = startActivityTracking();
	});

	afterEach(() => {
		stop();
		resetActivityBufferForTests();
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	const durations = () =>
		recordActivityEvents.mock.calls
			.flatMap(([batch]) => batch)
			.filter(
				(event): event is { kind: string; path: string; durMs: number } =>
					Boolean(event) &&
					typeof event === "object" &&
					"kind" in event &&
					event.kind === "paper.blur",
			);

	it("caps all checkpoints and the session at 30 minutes of uninterrupted focus", async () => {
		notePaperFocus("papers/demo");
		await vi.advanceTimersByTimeAsync(35 * 60_000);
		expect(durations().reduce((sum, event) => sum + event.durMs, 0)).toBe(
			30 * 60_000,
		);
		const slices = durations().length;
		await vi.advanceTimersByTimeAsync(5 * 60_000);
		expect(durations()).toHaveLength(slices);
		notePaperFocus(null);
		windowEvents.dispatchEvent(new Event("blur"));
		await flushActivity();
		expect(
			recordActivityEvents.mock.calls
				.flatMap(([batch]) => batch)
				.filter(
					(event) =>
						event != null &&
						typeof event === "object" &&
						"kind" in event &&
						event.kind === "paper.session",
				),
		).toEqual([
			expect.objectContaining({
				path: "papers/demo",
				durMs: 30 * 60_000,
			}),
		]);
	});

	it("starts a fresh allowance after a capped segment blurs and refocuses", async () => {
		notePaperFocus("papers/demo");
		await vi.advanceTimersByTimeAsync(35 * 60_000);
		foreground = false;
		windowEvents.dispatchEvent(new Event("blur"));
		await vi.advanceTimersByTimeAsync(60_000);
		foreground = true;
		windowEvents.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(20_000);
		notePaperFocus(null);
		await flushActivity();
		expect(durations().reduce((sum, event) => sum + event.durMs, 0)).toBe(
			30 * 60_000 + 20_000,
		);
		expect(
			recordActivityEvents.mock.calls
				.flatMap(([batch]) => batch)
				.filter(
					(event) =>
						event != null &&
						typeof event === "object" &&
						"kind" in event &&
						event.kind === "paper.session",
				),
		).toEqual([
			expect.objectContaining({ durMs: 30 * 60_000 }),
			expect.objectContaining({ durMs: 20_000 }),
		]);
	});

	it("adds 50s and 10s around a window blur without counting time away", async () => {
		notePaperFocus("papers/demo");
		await vi.advanceTimersByTimeAsync(50_000);
		foreground = false;
		windowEvents.dispatchEvent(new Event("blur"));
		await vi.advanceTimersByTimeAsync(120_000);
		foreground = true;
		windowEvents.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(10_000);
		notePaperFocus(null);
		await flushActivity();
		expect(durations().reduce((sum, event) => sum + event.durMs, 0)).toBe(
			60_000,
		);
	});

	it("keeps repeated focus and split-pane switches from counting overlapping time", async () => {
		notePaperFocus("papers/a");
		await vi.advanceTimersByTimeAsync(600);
		notePaperFocus("/Users/me/vault/papers/a");
		await vi.advanceTimersByTimeAsync(600);
		notePaperFocus("papers/b");
		await vi.advanceTimersByTimeAsync(400);
		notePaperFocus("papers/a");
		await vi.advanceTimersByTimeAsync(400);
		notePaperFocus(null);
		await flushActivity();
		expect(
			durations()
				.filter((e) => e.path === "papers/a")
				.reduce((sum, e) => sum + e.durMs, 0),
		).toBe(1600);
		expect(
			durations()
				.filter((e) => e.path === "papers/b")
				.reduce((sum, e) => sum + e.durMs, 0),
		).toBe(400);
	});

	it("pauses while hidden, resumes once, and never resumes a closed paper", async () => {
		notePaperFocus("papers/demo");
		await vi.advanceTimersByTimeAsync(2000);
		visible = false;
		documentEvents.dispatchEvent(new Event("visibilitychange"));
		await vi.advanceTimersByTimeAsync(20_000);
		visible = true;
		documentEvents.dispatchEvent(new Event("visibilitychange"));
		windowEvents.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(3000);
		notePaperFocus(null);
		windowEvents.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(20_000);
		await flushActivity();
		expect(durations().reduce((sum, event) => sum + event.durMs, 0)).toBe(5000);
	});

	it("keeps checkpoint and final slices attributed to the original vault", async () => {
		notePaperFocus("papers/demo");
		await vi.advanceTimersByTimeAsync(12_000);
		vaultState.path = "/Users/me/other-vault";
		notePaperFocus("papers/demo");
		await vi.advanceTimersByTimeAsync(3000);
		notePaperFocus(null);
		await flushActivity();
		expect(durations()).toEqual([
			expect.objectContaining({ vault: "/Users/me/vault", durMs: 5000 }),
			expect.objectContaining({ vault: "/Users/me/vault", durMs: 5000 }),
			expect.objectContaining({ vault: "/Users/me/vault", durMs: 2000 }),
			expect.objectContaining({ vault: "/Users/me/other-vault", durMs: 3000 }),
		]);
	});

	it("does not start a newly selected paper while the window is blurred", async () => {
		foreground = false;
		windowEvents.dispatchEvent(new Event("blur"));
		notePaperFocus("papers/demo");
		await vi.advanceTimersByTimeAsync(60_000);
		foreground = true;
		windowEvents.dispatchEvent(new Event("focus"));
		await vi.advanceTimersByTimeAsync(1000);
		notePaperFocus(null);
		await flushActivity();
		expect(durations().reduce((sum, event) => sum + event.durMs, 0)).toBe(1000);
	});
});
