// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskUserQuestionForm } from "@/components/agent/ask-user-question-form";
import {
	type AskUserAnswer,
	type AskUserQuestion,
	elicitationContentFromAnswers,
	questionsFromElicitationFields,
} from "@/lib/agent/chat-state";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: vi.fn() }));
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
afterEach(async () => {
	if (root) await act(async () => root.unmount());
	document.body.replaceChildren();
});

async function mount(
	questions: AskUserQuestion[],
	onSubmit = vi.fn(async (_answers: AskUserAnswer[]) => true),
) {
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
	await act(async () =>
		root.render(createElement(AskUserQuestionForm, { questions, onSubmit })),
	);
	return onSubmit;
}
async function click(selector: string) {
	await act(async () => (host.querySelector(selector) as HTMLElement)?.click());
}
async function submit() {
	await act(async () => host.querySelector("form")?.requestSubmit());
}
async function type(text: string) {
	const input = host.querySelector("input[type=text]") as HTMLInputElement;
	await act(async () => {
		Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)?.set?.call(input, text);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
}

describe("ACP questionnaire adapter", () => {
	it("renders an ACP multiselect schema and returns native option values as an array", async () => {
		const questions = questionsFromElicitationFields([
			{
				id: "outputs",
				title: "Choose outputs",
				required: true,
				kind: "multiselect",
				options: [
					{ value: "code", title: "Code, docs" },
					{ value: "tests", title: "Tests" },
				],
			},
		]);
		const sent = await mount(questions);
		expect(host.querySelectorAll("input[type=checkbox]")).toHaveLength(2);
		await click('input[value="Code, docs"]');
		await click('input[value="Tests"]');
		await submit();
		const answers = sent.mock.calls[0]?.[0];
		expect(answers).toEqual([["Code, docs", "Tests"]]);
		expect(elicitationContentFromAnswers(questions, answers ?? [])).toEqual({
			outputs: ["code", "tests"],
		});
	});
	it("keeps multiple choices structured until the response boundary", async () => {
		const sent = await mount([
			{
				question: "Sources?",
				multiSelect: true,
				options: [{ label: "Code, docs" }, { label: "Tests" }],
			},
		]);
		await click('input[value="Code, docs"]');
		await click('input[value="Tests"]');
		await submit();
		expect(sent).toHaveBeenCalledWith([["Code, docs", "Tests"]]);
	});

	it("lets freeform Other replace a single choice", async () => {
		const sent = await mount([
			{ question: "Pick?", allowOther: true, options: [{ label: "A" }] },
		]);
		await click('input[value="A"]');
		await type("Custom answer");
		await submit();
		expect(sent).toHaveBeenCalledWith(["Custom answer"]);
	});

	it("uses upstream keyboard navigation and preserves answers on a rejected submission", async () => {
		const sent = vi.fn(async (_answers: AskUserAnswer[]) => false);
		await mount(
			[
				{ question: "First?", options: [{ label: "A" }] },
				{ question: "Second?", options: [{ label: "B" }] },
			],
			sent,
		);
		await click('input[value="A"]');
		await act(async () =>
			host
				.querySelector('input[value="A"]')
				?.dispatchEvent(
					new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
				),
		);
		expect(
			host.querySelector("[data-slot=questionnaire-item]:not([hidden])")
				?.textContent,
		).toContain("Second?");
		await click('input[value="B"]');
		await submit();
		await submit();
		expect(sent).toHaveBeenCalledTimes(2);
		expect(sent).toHaveBeenLastCalledWith(["A", "B"]);
	});

	it("blocks required unanswered questions and permits an optional blank answer", async () => {
		const sent = await mount([
			{ question: "Required?", options: [{ label: "A" }] },
			{ question: "Optional?", required: false, options: [] },
		]);
		await submit();
		expect(sent).not.toHaveBeenCalled();
		expect(
			host.querySelector("[data-slot=questionnaire-error][role=alert]")
				?.textContent,
		).toBe("askUserQuestion.answerRequired");
		await click('input[value="A"]');
		await click("[data-slot=questionnaire-next]");
		expect(
			host.querySelector("[role=progressbar]")?.getAttribute("aria-valuenow"),
		).toBe("2");
		expect(
			host.querySelector("[role=progressbar]")?.getAttribute("aria-label"),
		).toBe("Required?");
		await click("[data-slot=questionnaire-skip]");
		expect(sent).toHaveBeenCalledWith(["A", ""]);
	});

	it("restores controls and preserves the answer after a transport error", async () => {
		const sent = vi
			.fn(async (_answers: AskUserAnswer[]) => false)
			.mockRejectedValueOnce(new Error("offline"));
		await mount([{ question: "Pick?", options: [{ label: "A" }] }], sent);
		await click('input[value="A"]');
		await submit();
		expect(
			(host.querySelector('input[value="A"]') as HTMLInputElement).disabled,
		).toBe(false);
		await submit();
		expect(sent).toHaveBeenCalledTimes(2);
		expect(sent).toHaveBeenLastCalledWith(["A"]);
	});
});
