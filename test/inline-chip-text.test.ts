// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InlineChipText } from "@/components/agent/inline-chip-text";
import { encodeMentionToken } from "@/lib/agent/composer-inline-tokens";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.append(container);
	root = createRoot(container);
});

afterEach(async () => {
	await act(() => root.unmount());
	container.remove();
});

describe("InlineChipText", () => {
	it("draws the file chip in place and opens the path", async () => {
		const onOpenPath = vi.fn();
		const markup = `帮我梳理一下 ${encodeMentionToken("notes/论文关系图.md")}`;
		await act(() =>
			root.render(
				createElement(InlineChipText, {
					markup,
					onOpenPath,
				}),
			),
		);
		expect(container.textContent).toContain("帮我梳理一下");
		expect(container.textContent).toContain("论文关系图.md");
		expect(container.textContent).not.toContain("{{m:");
		const chip = container.querySelector("[data-composer-chip]");
		expect(chip).toBeTruthy();
		chip?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		expect(onOpenPath).toHaveBeenCalledWith("notes/论文关系图.md");
	});

	it("can show chips without the surrounding prose", async () => {
		const markup = `帮我梳理一下 ${encodeMentionToken("notes/论文关系图.md")}`;
		await act(() =>
			root.render(
				createElement(InlineChipText, {
					markup,
					chipsOnly: true,
				}),
			),
		);
		expect(container.textContent).not.toContain("帮我梳理一下");
		expect(container.textContent).toContain("@");
		expect(container.textContent).toContain("论文关系图.md");
	});
});
