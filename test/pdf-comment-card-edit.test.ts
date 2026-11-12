// @vitest-environment happy-dom

import { MarkdownPlugin } from "@platejs/markdown";
import { createSlateEditor } from "platejs";
import { act, createElement, StrictMode, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CommentMarkdownKit } from "@/components/editor/plugins/comment-markdown-kit";
import { CommentCardsLayer } from "@/components/viewer/pdf/layers/comment-cards-layer";
import type { PageAnnotationComment } from "@/components/viewer/pdf/types";
import { deserializeMarkdownBody } from "@/lib/markdown/deserialize-md";

vi.mock("react-i18next", () => ({
	initReactI18next: { type: "3rdParty", init: () => undefined },
	useTranslation: () => ({ t: (key: string) => key }),
}));

// Plate's onChange fires with normalized Markdown (trailing newline) even
// without user input, e.g. from mount-time normalization. Reproduce that
// emit so the card's unmount-commit guard is exercised under StrictMode.
vi.mock("@/components/viewer/pdf/layers/comment-markdown-editor", () => ({
	CommentMarkdownEditor: ({
		initialValue,
		onChange,
	}: {
		initialValue: string;
		onChange?: (markdown: string) => void;
	}) => {
		const onChangeRef = useRef(onChange);
		onChangeRef.current = onChange;
		useEffect(() => {
			onChangeRef.current?.(`${initialValue}\n`);
		}, [initialValue]);
		return createElement(
			"div",
			{ "data-comment-editor": true },
			createElement("button", {
				type: "button",
				"data-comment-type": true,
				onClick: () => onChangeRef.current?.("edited note"),
			}),
		);
	},
}));

class NoopResizeObserver {
	observe() {}
	unobserve() {}
	disconnect() {}
}

const item: PageAnnotationComment = {
	id: "c1",
	pageIndex: 0,
	anchorY: 0.5,
	rects: [{ x: 0.1, y: 0.5, w: 0.3, h: 0.02 }],
	quote: "quoted text",
	comment: "note",
	color: "yellow",
	kind: "highlight",
	linkAlias: null,
};

function layerProps(
	onSave: (comment: PageAnnotationComment, text: string) => void,
) {
	return {
		items: [item],
		pageWidthPx: 600,
		pageHeightPx: 800,
		editingId: "c1",
		wikiTarget: null,
		hoveredId: null,
		onOpen: vi.fn(),
		onSave,
		onCancel: vi.fn(),
		onDelete: vi.fn(),
		onCopyLink: vi.fn(),
		onCopyEmbed: vi.fn(),
		onAddToChat: vi.fn(),
		onHover: vi.fn(),
		onLeave: vi.fn(),
	};
}

beforeEach(() => {
	vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
	vi.stubGlobal("ResizeObserver", NoopResizeObserver);
	(
		document.defaultView as unknown as { ResizeObserver: unknown }
	).ResizeObserver = NoopResizeObserver;
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("comment card in-place editing", () => {
	it("opens the editor when the card body is clicked", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const onOpen = vi.fn();
		const onSave = vi.fn();
		const props = layerProps(onSave);
		try {
			await act(async () => {
				root.render(
					createElement(
						StrictMode,
						null,
						createElement(CommentCardsLayer, {
							...props,
							editingId: null,
							onOpen,
						}),
					),
				);
			});
			await act(async () => {
				host
					.querySelector<HTMLElement>('[role="button"]')
					?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			});
			expect(onOpen).toHaveBeenCalledOnce();

			await act(async () => {
				root.render(
					createElement(
						StrictMode,
						null,
						createElement(CommentCardsLayer, {
							...props,
							onOpen,
						}),
					),
				);
			});
			expect(host.querySelector("[data-comment-editor]")).not.toBeNull();
			expect(onSave).not.toHaveBeenCalled();
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});

	it("stays open under StrictMode when the editor only normalizes the note", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const onSave = vi.fn();
		try {
			await act(async () => {
				root.render(
					createElement(
						StrictMode,
						null,
						createElement(CommentCardsLayer, layerProps(onSave)),
					),
				);
			});
			// StrictMode's fake unmount must not treat the normalized draft as
			// an edit: a spurious save closes the editor the moment it opens.
			expect(onSave).not.toHaveBeenCalled();
			expect(host.querySelector("[data-comment-editor]")).not.toBeNull();
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});

	it("commits a genuine edit when page virtualization unmounts the card", async () => {
		const host = document.createElement("div");
		document.body.append(host);
		const root = createRoot(host);
		const onSave = vi.fn();
		try {
			await act(async () => {
				root.render(
					createElement(
						StrictMode,
						null,
						createElement(CommentCardsLayer, layerProps(onSave)),
					),
				);
			});
			await act(async () => {
				host.querySelector<HTMLButtonElement>("[data-comment-type]")?.click();
			});
			expect(onSave).not.toHaveBeenCalled();
			await act(async () => root.unmount());
			expect(onSave).toHaveBeenCalledExactlyOnceWith(item, "edited note");
		} finally {
			await act(async () => root.unmount());
			host.remove();
		}
	});
});

describe("comment markdown roundtrip", () => {
	it("serializes a bullet list back to markdown source", () => {
		const editor = createSlateEditor({ plugins: CommentMarkdownKit });
		editor.children = deserializeMarkdownBody(
			editor,
			"- bullet note\n- second item",
		);
		const out = editor.getApi(MarkdownPlugin).markdown.serialize();
		expect(out).toMatch(/^[-*] bullet note$/m);
		expect(out).toContain("second item");
	});

	it("roundtrips plain mixed CJK text", () => {
		const source = "Mock comment 示例文本";
		const editor = createSlateEditor({ plugins: CommentMarkdownKit });
		editor.children = deserializeMarkdownBody(editor, source);
		const out = editor.getApi(MarkdownPlugin).markdown.serialize();
		expect(out.trim()).toBe(source);
	});
});
