// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TranslationGlossaryEditor } from "@/components/settings/translation-glossary-editor";
import { notifyError } from "@/lib/core/notify";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@/lib/core/notify", () => ({ notifyError: vi.fn() }));
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});
afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
	vi.clearAllMocks();
	vi.unstubAllGlobals();
});
async function edit(value: string) {
	const input = container.querySelector("textarea");
	if (!input) throw new Error("Missing terminology editor");
	await act(() => {
		Object.getOwnPropertyDescriptor(
			HTMLTextAreaElement.prototype,
			"value",
		)?.set?.call(input, value);
		input.dispatchEvent(new Event("input", { bubbles: true }));
	});
	return input;
}
function button(label: string) {
	const found = Array.from(container.querySelectorAll("button")).find(
		(b) => b.textContent === `translate.glossary.${label}`,
	);
	if (!found) throw new Error(`Missing ${label}`);
	return found;
}
it("saves valid pairs as JSON and lets users clear their own glossary", async () => {
	const save = vi.fn();
	await act(() =>
		root.render(
			createElement(TranslationGlossaryEditor, {
				value: "",
				language: "Chinese",
				onSave: save,
			}),
		),
	);
	await edit("LLM→大模型\nKV cache:KV 缓存");
	await act(() => button("save").click());
	expect(JSON.parse(save.mock.calls[0][0])).toEqual({
		LLM: "大模型",
		"KV cache": "KV 缓存",
	});
	await act(() =>
		root.render(
			createElement(TranslationGlossaryEditor, {
				value: save.mock.calls[0][0],
				language: "Chinese",
				onSave: save,
			}),
		),
	);
	await edit("");
	await act(() => button("save").click());
	expect(save).toHaveBeenLastCalledWith("");
});
it("keeps invalid edits visible without overwriting saved terms, then cancels cleanly", async () => {
	const save = vi.fn();
	const stored = '{"LLM":"大模型"}';
	await act(() =>
		root.render(
			createElement(TranslationGlossaryEditor, {
				value: stored,
				language: "Chinese",
				onSave: save,
			}),
		),
	);
	const input = await edit('{"LLM":');
	await act(() => button("save").click());
	expect(save).not.toHaveBeenCalled();
	expect(notifyError).toHaveBeenCalledWith("translate.glossary.invalid");
	expect(input.value).toBe('{"LLM":');
	expect(input.getAttribute("aria-invalid")).toBe("true");
	await act(() => button("cancel").click());
	expect(input.value).toBe(stored);
	expect(button("save").disabled).toBe(true);
});
