import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	beginLayoutAnalysisAttempt,
	finishLayoutAnalysisAttempt,
	resetLayoutAnalysisCrashGuard,
	shouldSkipAutoLayoutAnalysis,
} from "@/lib/pdf/layout/crash-guard";

const STORAGE_KEY = "agentero.pdfLayout.crashGuard";
const PAPER = "/vault/papers/2024-attention";

describe("pdf layout crash guard", () => {
	let store: Map<string, string>;

	beforeEach(() => {
		store = new Map<string, string>();
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: {
				getItem: (k: string) => store.get(k) ?? null,
				setItem: (k: string, v: string) => store.set(k, v),
				removeItem: (k: string) => store.delete(k),
			},
		});
	});

	it("does not skip a paper that never ran", () => {
		expect(shouldSkipAutoLayoutAnalysis(PAPER)).toBe(false);
	});

	it("does not skip after a normally finished attempt", () => {
		beginLayoutAnalysisAttempt(PAPER);
		finishLayoutAnalysisAttempt(PAPER);
		expect(shouldSkipAutoLayoutAnalysis(PAPER)).toBe(false);
		expect(store.has(STORAGE_KEY)).toBe(false);
	});

	it("allows one retry after a single mid-run crash, then skips", () => {
		// Crash 1: begin without finish (WebContent process died, page reloaded).
		beginLayoutAnalysisAttempt(PAPER);
		expect(shouldSkipAutoLayoutAnalysis(PAPER)).toBe(false);

		// Crash 2: the retry also never finishes.
		beginLayoutAnalysisAttempt(PAPER);
		expect(shouldSkipAutoLayoutAnalysis(PAPER)).toBe(true);
	});

	it("keeps counting crashes across reloads via storage", () => {
		beginLayoutAnalysisAttempt(PAPER);
		beginLayoutAnalysisAttempt(PAPER);
		const raw = store.get(STORAGE_KEY);
		expect(raw).toBeTruthy();
		const state = JSON.parse(raw as string) as Record<
			string,
			{ attempts: number; inFlight: boolean }
		>;
		expect(state[PAPER]?.attempts).toBe(2);
		expect(state[PAPER]?.inFlight).toBe(true);
	});

	it("a successful run after one crash clears the counter", () => {
		beginLayoutAnalysisAttempt(PAPER);
		// Reload, retry, and this time it completes.
		beginLayoutAnalysisAttempt(PAPER);
		finishLayoutAnalysisAttempt(PAPER);
		expect(shouldSkipAutoLayoutAnalysis(PAPER)).toBe(false);
	});

	it("manual reset re-enables automatic analysis", () => {
		beginLayoutAnalysisAttempt(PAPER);
		beginLayoutAnalysisAttempt(PAPER);
		expect(shouldSkipAutoLayoutAnalysis(PAPER)).toBe(true);
		resetLayoutAnalysisCrashGuard(PAPER);
		expect(shouldSkipAutoLayoutAnalysis(PAPER)).toBe(false);
	});

	it("normalizes trailing slashes and backslashes to one key", () => {
		beginLayoutAnalysisAttempt("C:\\vault\\papers\\x\\");
		beginLayoutAnalysisAttempt("C:/vault/papers/x");
		expect(shouldSkipAutoLayoutAnalysis("C:/vault/papers/x/")).toBe(true);
	});

	it("expired crash records stop blocking automatic analysis", () => {
		vi.useFakeTimers();
		try {
			vi.setSystemTime(new Date("2026-08-01T00:00:00Z"));
			beginLayoutAnalysisAttempt(PAPER);
			beginLayoutAnalysisAttempt(PAPER);
			expect(shouldSkipAutoLayoutAnalysis(PAPER)).toBe(true);

			vi.setSystemTime(new Date("2026-08-09T00:00:01Z"));
			expect(shouldSkipAutoLayoutAnalysis(PAPER)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("tracks papers independently", () => {
		beginLayoutAnalysisAttempt(PAPER);
		beginLayoutAnalysisAttempt(PAPER);
		expect(shouldSkipAutoLayoutAnalysis(PAPER)).toBe(true);
		expect(shouldSkipAutoLayoutAnalysis("/vault/papers/other")).toBe(false);
	});

	it("survives corrupted storage content", () => {
		store.set(STORAGE_KEY, "{not json");
		expect(shouldSkipAutoLayoutAnalysis(PAPER)).toBe(false);
		beginLayoutAnalysisAttempt(PAPER);
		beginLayoutAnalysisAttempt(PAPER);
		expect(shouldSkipAutoLayoutAnalysis(PAPER)).toBe(true);
	});

	it("is a no-op without localStorage", () => {
		Object.defineProperty(globalThis, "localStorage", {
			configurable: true,
			value: undefined,
		});
		expect(() => beginLayoutAnalysisAttempt(PAPER)).not.toThrow();
		expect(shouldSkipAutoLayoutAnalysis(PAPER)).toBe(false);
		expect(() => finishLayoutAnalysisAttempt(PAPER)).not.toThrow();
	});
});
