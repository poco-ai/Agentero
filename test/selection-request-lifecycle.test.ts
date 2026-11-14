// @vitest-environment happy-dom
import { act, createElement, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	createSelectionAskThread,
	useSelectionAsk,
} from "@/components/selection/use-selection-ask";
import { useSelectionTranslation } from "@/components/selection/use-selection-translation";
import type { RunAskTurnOptions } from "@/lib/pdf/ask/run-turn";
import type { RunSelectionTranslateOptions } from "@/lib/pdf/translate/run-selection";
import {
	claimSelectionTranslation,
	releaseSelectionTranslation,
} from "@/lib/workspace/selection-card-owner";

const mocks = vi.hoisted(() => ({
	translate: vi.fn(),
	resolve: vi.fn(),
	ask: vi.fn(),
}));
vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init() {} },
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/pdf/translate/run-selection", () => ({
	runSelectionTranslate: mocks.translate,
}));
vi.mock("@/lib/pdf/ask/run-turn", () => ({
	resolveAskAgent: mocks.resolve,
	runAskTurn: mocks.ask,
	resendBaseMessages: vi.fn(),
}));

let root: Root;
let container: HTMLDivElement;
let translation: ReturnType<typeof useSelectionTranslation>;
let ask: ReturnType<typeof useSelectionAsk<{ x: number; y: number }>>;
const screen = { x: 100, y: 200 };
const source = {
	id: "first",
	text: "original evidence",
	sourcePath: "https://example.org/first",
	origin: "markdown" as const,
	pinned: false,
};
function Probe() {
	translation = useSelectionTranslation();
	ask = useSelectionAsk({
		activeSessionRef: useRef<string | null>(null),
		buildPrompt: (thread) => thread.anchor.quote,
	});
	return null;
}
beforeEach(async () => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.clearAllMocks();
	mocks.resolve.mockResolvedValue({ agentId: "test-agent" });
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
	await act(() => root.render(createElement(Probe)));
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	vi.unstubAllGlobals();
});

it("disposes replaced and closed translations and ignores their late replies", async () => {
	await act(() => translation.translate(source, screen));
	const first = mocks.translate.mock
		.lastCall?.[0] as RunSelectionTranslateOptions;
	await act(() => first.appendChunk("partial"));
	expect(translation.translation?.result).toBe("partial");
	await act(() =>
		translation.translate(
			{ ...source, id: "second", text: "second quote" },
			screen,
		),
	);
	const second = mocks.translate.mock
		.lastCall?.[0] as RunSelectionTranslateOptions;
	expect(first.disposedRef.current).toBe(true);
	await act(() => {
		first.commitProviderResult("stale");
		first.markFailed("stale error");
		second.commitProviderResult("second translation");
	});
	expect(translation.translation).toMatchObject({
		result: "second translation",
		error: null,
		selection: { text: "second quote" },
	});
	await act(() => translation.close());
	expect(second.disposedRef.current).toBe(true);
	await act(() => second.commitProviderResult("late success"));
	expect(translation.translation).toBeNull();
});

it("shares translation ownership with PDF cards", async () => {
	const closePdf = vi.fn();
	claimSelectionTranslation(closePdf);
	await act(() => translation.translate(source, screen));
	expect(closePdf).toHaveBeenCalledOnce();
	const request = mocks.translate.mock
		.lastCall?.[0] as RunSelectionTranslateOptions;
	await act(() => claimSelectionTranslation(closePdf));
	expect(translation.translation).toBeNull();
	expect(request.disposedRef.current).toBe(true);
	releaseSelectionTranslation(closePdf);
});

it("does not dispatch an Ask accepted after closing during Agent discovery", async () => {
	let resolve!: (agent: { agentId: string }) => void;
	mocks.resolve.mockReturnValue(
		new Promise((value) => {
			resolve = value;
		}),
	);
	await act(() =>
		ask.setAsk({
			thread: createSelectionAskThread("first.md", "first quote"),
			screen,
		}),
	);
	await act(() => ask.sendAskQuestion("explain"));
	expect(ask.streaming).toBe(true);
	await act(() => ask.hideAsk());
	await act(() => resolve({ agentId: "test-agent" }));
	expect(mocks.ask).not.toHaveBeenCalled();
	expect(ask.ask).toBeNull();
	expect(ask.streaming).toBe(false);
});

it("retains errors reported after streaming stops and isolates replacement Ask threads", async () => {
	await act(() =>
		ask.setAsk({
			thread: createSelectionAskThread("first.md", "first quote"),
			screen,
		}),
	);
	await act(() => ask.sendAskQuestion("explain"));
	const first = mocks.ask.mock.lastCall?.[0] as RunAskTurnOptions;
	await act(() => {
		first.setStreaming(false);
		first.setAskError("connection failed");
	});
	expect(ask.askError).toBe("connection failed");
	await act(() =>
		ask.setAsk({
			thread: createSelectionAskThread("second.md", "second quote"),
			screen,
		}),
	);
	expect(first.disposedRef.current).toBe(true);
	await act(() => {
		first.upsertThread({ ...first.thread, messages: [] });
		first.setAskError("old error");
	});
	expect(ask.ask?.thread.anchor.quote).toBe("second quote");
	expect(ask.askError).toBeNull();
});
