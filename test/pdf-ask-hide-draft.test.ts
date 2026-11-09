// @vitest-environment happy-dom

import { act, createElement, useCallback, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	type PdfAskThreads,
	usePdfAskThreads,
} from "@/components/viewer/pdf/hooks/use-pdf-ask-threads";
import type { CardScreenPoint } from "@/components/viewer/pdf/types";
import { createEmptyThread } from "@/lib/pdf/ask";
import type { PdfAskThread } from "@/lib/pdf/ask/types";
import type { ActiveSelectionCard } from "@/lib/pdf/selection";

vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init: () => undefined },
	useTranslation: () => ({ t: (key: string) => key }),
}));

let root: Root;
let api: PdfAskThreads;
let renderedThreads: PdfAskThread[];
let activeCardRef: { current: ActiveSelectionCard | null };
let initialThread: PdfAskThread;

function Harness() {
	const [threads, setThreads] = useState<PdfAskThread[]>(() => [initialThread]);
	const [, setActiveCard] = useState<ActiveSelectionCard | null>({
		kind: "ask",
		id: initialThread.id,
	});
	const [, setCardScreen] = useState<CardScreenPoint | null>(null);
	const threadsRef = useRef(threads);
	threadsRef.current = threads;
	activeCardRef = useRef<ActiveSelectionCard | null>({
		kind: "ask",
		id: initialThread.id,
	});
	const activeSessionRef = useRef<string | null>(null);
	const upsertThread = useCallback((thread: PdfAskThread) => {
		setThreads((prev) => {
			const index = prev.findIndex((item) => item.id === thread.id);
			if (index < 0) return [thread, ...prev];
			const next = [...prev];
			next[index] = thread;
			return next;
		});
	}, []);

	api = usePdfAskThreads({
		paperAbsPath: null,
		paperRelPath: "papers/x",
		vaultPath: null,
		threadsRef,
		setThreads,
		upsertThread,
		openCard: () => undefined,
		activeCardRef,
		setActiveCard,
		setCardScreen,
		activeSessionRef,
	});
	renderedThreads = threads;
	return null;
}

function draftThread(): PdfAskThread {
	return createEmptyThread({
		paperPath: "papers/x",
		anchor: {
			page: 1,
			rects: [{ x: 0.1, y: 0.2, w: 0.4, h: 0.03 }],
			quote: "selected text",
			trigger: "selection",
		},
	});
}

async function renderHarness(thread: PdfAskThread) {
	initialThread = thread;
	await act(() => root.render(createElement(Harness)));
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	root = createRoot(document.createElement("div"));
});

afterEach(async () => {
	await act(() => root.unmount());
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("keeps an untouched draft when the card is hidden", async () => {
	const draft = draftThread();
	await renderHarness(draft);
	await act(() => api.hideAskThread());
	expect(renderedThreads).toHaveLength(1);
	expect(renderedThreads[0]?.status).toBe("open");
});

it("keeps typed draft text when the card is hidden", async () => {
	const draft = draftThread();
	await renderHarness(draft);
	await act(() => api.hideAskThread("half-written question"));
	expect(renderedThreads).toHaveLength(1);
	expect(renderedThreads[0]?.draft).toBe("half-written question");
});

it("keeps a conversation with a question and marks it ended", async () => {
	const thread = draftThread();
	thread.messages.push({
		id: "message-1",
		role: "user",
		content: "What does this mean?",
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	await renderHarness(thread);
	await act(() => api.hideAskThread());
	expect(renderedThreads).toHaveLength(1);
	expect(renderedThreads[0]?.status).toBe("ended");
});

it("keeps an unsent follow-up draft on an existing conversation", async () => {
	const thread = draftThread();
	thread.messages.push({
		id: "message-1",
		role: "user",
		content: "What does this mean?",
		createdAt: "2026-01-01T00:00:00.000Z",
	});
	await renderHarness(thread);
	await act(() => api.hideAskThread("and the follow-up?"));
	expect(renderedThreads[0]?.status).toBe("ended");
	expect(renderedThreads[0]?.draft).toBe("and the follow-up?");
});

it("keeps an untouched draft when another card closes it", async () => {
	const draft = draftThread();
	await renderHarness(draft);
	await act(() => api.closeAskChrome(draft.id));
	expect(renderedThreads).toHaveLength(1);
});

it("deletes the open draft when the card asks to remove it", async () => {
	const draft = draftThread();
	await renderHarness(draft);
	await act(() => api.deleteAskThread());
	expect(renderedThreads).toEqual([]);
});
