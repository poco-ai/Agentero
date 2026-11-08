// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatTranscript } from "@/components/agent/chat-transcript";
import {
	Conversation,
	ConversationContent,
} from "@/components/agent/conversation";
import {
	agentSessionStore,
	EMPTY_CHAT_LINES,
} from "@/lib/agent/agent-session-store";
import type { ChatLine } from "@/lib/agent/chat-state";

vi.mock("@/lib/settings", () => ({ useUiScale: () => 1 }));
vi.mock("react-i18next", async (importOriginal) => ({
	...(await importOriginal<typeof import("react-i18next")>()),
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/components/agent/rendering/message-response", () => ({
	MessageResponse: ({ children }: { children: ReactNode }) =>
		createElement("div", { "data-testid": "response" }, children),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});

afterEach(async () => {
	await act(async () => root.unmount());
	document.body.replaceChildren();
	agentSessionStore.setState({
		sessions: [],
		activeTabId: "draft",
		draftLines: EMPTY_CHAT_LINES,
	});
});

function setLines(lines: ChatLine[]) {
	agentSessionStore.setState({
		sessions: [
			{
				id: "s1",
				agentId: "agent",
				source: "local",
				title: "Session",
				agentName: "Agent",
				startedAt: "",
				lines,
				status: "running",
			},
		],
		activeTabId: "s1",
		draftLines: EMPTY_CHAT_LINES,
	});
}

async function renderTranscript() {
	await act(async () =>
		root.render(
			createElement(
				Conversation,
				null,
				createElement(
					ConversationContent,
					null,
					createElement(ChatTranscript, {
						activeTabId: "s1",
						hydratingSessionId: null,
						activeTabIsRunning: true,
						submitting: false,
						switching: false,
						editingLineId: null,
						editingText: "",
						editTextareaRef: { current: null },
						editCompositionProps: {},
						isEditBlockedByIme: () => false,
						onEditingTextChange: () => {},
						onCancelEditing: () => {},
						onResendEdited: () => {},
						onStartEditing: () => {},
						onSendSuggestion: () => {},
					}),
				),
			),
		),
	);
}

function buttonContaining(text: string): HTMLButtonElement | undefined {
	return [...host.querySelectorAll("button")].find((button) =>
		button.textContent?.includes(text),
	);
}

async function click(text: string) {
	const button = buttonContaining(text);
	if (!button) throw new Error(`missing button: ${text}`);
	await act(async () => button.click());
}

describe("live transcript rendering", () => {
	it("compacts Pi references only in user bubbles without changing stored messages", async () => {
		const path = String.raw`C:\Users\Louis\.pi-desktop\scratch\session\pasted\pasted-context.txt`;
		const text = `Please read this\n\n@${path}`;
		setLines([
			{ id: "u1", kind: "user", text },
			{
				id: "a1",
				kind: "agent",
				streaming: false,
				parts: [{ id: "t1", type: "text", text }],
			},
		]);
		await renderTranscript();
		const user = host.querySelector(".is-user");
		expect(user?.textContent).toContain("pasted-context.txt");
		expect(user?.textContent).not.toContain(path);
		expect(host.querySelector(".is-assistant")?.textContent).toContain(path);
		expect(agentSessionStore.getState().sessions[0].lines[0]).toMatchObject({
			text,
		});
	});

	it("defaults to one line and toggles the synchronized live parts on click", async () => {
		setLines([
			{
				id: "a1",
				kind: "agent",
				streaming: true,
				parts: [
					{
						type: "reasoning",
						id: "r1",
						text: "Inspecting the selected paper first.",
					},
				],
			},
		]);
		await renderTranscript();

		const liveLine = buttonContaining("Inspecting the selected paper first.");
		expect(liveLine?.getAttribute("aria-expanded")).toBe("false");
		expect(buttonContaining("reasoning.thinking")).toBeUndefined();
		expect(host.querySelectorAll('[data-testid="response"]')).toHaveLength(0);

		await click("Inspecting the selected paper first.");
		expect(
			buttonContaining("Inspecting the selected paper first.")?.getAttribute(
				"aria-expanded",
			),
		).toBe("true");
		expect(
			buttonContaining("reasoning.thinking")?.getAttribute("aria-expanded"),
		).toBe("false");

		await click("reasoning.thinking");
		expect(host.querySelectorAll('[data-testid="response"]')).toHaveLength(1);

		await click("Inspecting the selected paper first.");
		expect(buttonContaining("reasoning.thinking")).toBeUndefined();
		expect(host.querySelectorAll('[data-testid="response"]')).toHaveLength(0);
	});

	it("shows recorded question and answer when an ask-user tool card expands", async () => {
		setLines([
			{
				id: "a1",
				kind: "agent",
				streaming: false,
				parts: [
					{
						type: "tool",
						id: "p1",
						tool: {
							id: "ask-1",
							title: "Ask 1 question",
							kind: "other",
							status: "completed",
							askUser: {
								questions: [
									{
										question: "Which language?",
										options: [{ label: "English" }, { label: "Chinese" }],
									},
								],
								answers: ["Chinese"],
							},
						},
					},
				],
			},
		]);
		await renderTranscript();

		await click("chainOfThought.title");
		await click("Ask 1 question");

		expect(host.textContent).toContain("Which language?");
		expect(host.textContent).toContain("Chinese");
	});
});
