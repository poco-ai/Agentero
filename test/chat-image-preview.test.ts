// @vitest-environment happy-dom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
	ChatAttachedImages,
	ChatVisualAnnotations,
} from "@/components/agent/chat-visual-annotations";
import type { ChatVisualAnnotation } from "@/lib/agent/chat-state";

vi.mock("react-i18next", () => ({
	useTranslation: () => ({
		t: (key: string, values?: unknown) =>
			`${key}${values ? JSON.stringify(values) : ""}`,
	}),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	host = document.createElement("div");
	document.body.append(host);
	root = createRoot(host);
});
afterEach(async () => {
	await act(() => root.unmount());
	host.remove();
	vi.unstubAllGlobals();
});

it("opens the selected attachment rather than the first image", async () => {
	await act(() =>
		root.render(
			createElement(ChatAttachedImages, {
				images: [
					{ data: "Zmlyc3Q=", mimeType: "image/png" },
					{ data: "c2Vjb25k", mimeType: "image/jpeg" },
				],
			}),
		),
	);
	await act(() =>
		host
			.querySelectorAll<HTMLButtonElement>("[data-slot=attachment-trigger]")[1]
			?.click(),
	);
	const dialog = document.querySelector("[role=dialog]");
	expect(dialog?.querySelector("img")?.getAttribute("src")).toBe(
		"data:image/jpeg;base64,c2Vjb25k",
	);
	expect(dialog?.textContent).toContain('"index":2');
});

it("keeps crop page, source and comment and closes when that annotation is removed", async () => {
	const annotation = {
		id: "crop",
		page: 7,
		paperPath: "papers/example.pdf",
		comment: "Check this figure",
		image: { data: "Y3JvcA==", mimeType: "image/png" },
	} as ChatVisualAnnotation;
	await act(() =>
		root.render(
			createElement(ChatVisualAnnotations, { annotations: [annotation] }),
		),
	);
	await act(() =>
		host
			.querySelector<HTMLButtonElement>("[data-slot=attachment-trigger]")
			?.click(),
	);
	const dialog = document.querySelector("[role=dialog]");
	expect(dialog?.textContent).toContain("papers/example.pdf");
	expect(dialog?.textContent).toContain('"page":7');
	expect(dialog?.textContent).toContain("Check this figure");
	await act(() =>
		root.render(createElement(ChatVisualAnnotations, { annotations: [] })),
	);
	expect(document.querySelector("[role=dialog]")).toBeNull();
});
