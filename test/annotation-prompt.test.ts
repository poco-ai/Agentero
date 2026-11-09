import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";
import {
	annotationOrdinal,
	proseWithAnnotationMarkers,
} from "@/lib/agent/annotation-prompt";
import {
	encodeSelectionToken,
	encodeVisualToken,
} from "@/lib/agent/composer-inline-tokens";
import { stripPromptEnvelopeForDisplay } from "@/lib/agent/prompt-display";
import type { SelectionContext } from "@/lib/agent/selection-store";
import { assembleTurnPrompt } from "@/lib/agent/turn-prompt";
import type { PdfVisualDraft } from "@/lib/agent/visual-context-store";

const t = ((key: string) => key) as unknown as TFunction<"agent", undefined>;

const selection: SelectionContext = {
	id: "s1",
	text: "分协议",
	sourcePath: "papers/x/NOTES.md",
	origin: "markdown",
	lineFrom: 18,
	lineTo: 18,
	comment: "看这里",
};

function visual(id: string, page: number, data: string): PdfVisualDraft {
	return {
		id,
		paperPath: "papers/x",
		page,
		rects: [],
		comment: `note ${id}`,
		image: { data, mimeType: "image/png" },
	};
}

describe("annotation markers in the turn prompt", () => {
	it("preserves RSS provenance and quotes through composer serialization", () => {
		const { prompt } = assembleTurnPrompt({
			text: `Explain ${encodeSelectionToken({ ...selection, sourcePath: "https://example.org/paper", sourceUrl: "https://example.org/paper", sourceTitle: "Research digest", surface: "feed", lineFrom: undefined, lineTo: undefined })}`,
			contextPaths: [],
			visualDrafts: [],
			attachedImages: [],
			isAcpCommand: false,
			t,
		});
		expect(prompt).toContain("## Annotation 1");
		expect(prompt).toContain("Research digest — https://example.org/paper");
		expect(prompt).toContain("> 分协议");
		expect(prompt).toContain("User comment on this selection:\n看这里");
	});
	it("keeps a shared number at the caret and in the appendix", () => {
		const raw = `这个公式 ${encodeSelectionToken(selection)} 和图 ${encodeVisualToken("mark-1")} 矛盾吗`;
		expect(proseWithAnnotationMarkers(raw)).toBe(
			"这个公式 [Annotation 1] 和图 [Annotation 2] 矛盾吗",
		);
		const { prompt, images } = assembleTurnPrompt({
			text: raw,
			contextPaths: [],
			visualDrafts: [visual("mark-1", 3, "crop")],
			attachedImages: [],
			isAcpCommand: false,
			t,
		});
		expect(
			prompt.startsWith("这个公式 [Annotation 1] 和图 [Annotation 2] 矛盾吗"),
		).toBe(true);
		expect(prompt).not.toContain("> 分协议");
		expect(prompt).not.toContain("User comment on this selection:\n看这里");
		expect(prompt).toContain("## Annotation 2\nVisual annotation — page 3");
		expect(prompt).toContain("User comment: note mark-1");
		expect(prompt).toContain(
			"Attached images, in order, are the crops for: Annotation 2.",
		);
		expect(prompt.indexOf("[Annotation 1]")).toBeLessThan(
			prompt.indexOf("## Annotation 2"),
		);
		expect(images?.map((image) => image.data)).toEqual(["crop"]);
		expect(stripPromptEnvelopeForDisplay(prompt)).toBe(
			"这个公式 [Annotation 1] 和图 [Annotation 2] 矛盾吗",
		);
	});

	it("numbers a visual before a text selection in document order", () => {
		const raw = `${encodeVisualToken("mark-1")} 然后 ${encodeSelectionToken(selection)}`;
		expect(annotationOrdinal(raw, "visual", "mark-1")).toBe(1);
		expect(annotationOrdinal(raw, "selection", selection.id)).toBe(2);
		expect(annotationOrdinal(raw, "visual", "missing")).toBeNull();
	});

	it("orders crops by where the blocks sit, not by draft-store order", () => {
		const raw = `${encodeVisualToken("b")} 然后 ${encodeVisualToken("a")}`;
		const { prompt, images } = assembleTurnPrompt({
			text: raw,
			contextPaths: [],
			visualDrafts: [visual("a", 1, "img-a"), visual("b", 2, "img-b")],
			attachedImages: [{ data: "paste", mimeType: "image/png" }],
			isAcpCommand: false,
			t,
		});
		expect(proseWithAnnotationMarkers(raw)).toBe(
			"[Annotation 1] 然后 [Annotation 2]",
		);
		expect(prompt).toContain(
			"Attached images, in order, begin with the crops for: Annotation 1, Annotation 2.",
		);
		expect(images?.map((image) => image.data)).toEqual([
			"img-b",
			"img-a",
			"paste",
		]);
	});

	it("reuses one number when the same visual block is repeated", () => {
		const token = encodeVisualToken("mark-1");
		expect(proseWithAnnotationMarkers(`看 ${token} 再看 ${token}`)).toBe(
			"看 [Annotation 1] 再看 [Annotation 1]",
		);
	});

	it("leaves a selection list without inline tokens on the previous appendix", () => {
		const { prompt } = assembleTurnPrompt({
			text: "解释一下",
			contextPaths: [],
			visualDrafts: [],
			attachedImages: [],
			isAcpCommand: false,
			t,
		});
		expect(prompt).toContain("解释一下");
		expect(prompt).not.toContain("[Annotation 1]");
		expect(prompt).not.toContain("Selected text from papers/x/NOTES.md");
	});
});
