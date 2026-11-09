import { expect, it } from "vitest";
import {
	pdfAskContextRequest,
	sidebarContextRequest,
} from "@/lib/agent/context-request";
import { createEmptyThread } from "@/lib/pdf/ask";
import { rememberPairedAskTranslation } from "@/lib/pdf/ask/prompt";

it("sends the PDF quote, page, and translation to the shared resolver", () => {
	const thread = createEmptyThread({
		paperPath: "papers/x",
		anchor: {
			page: 3,
			rects: [{ x: 0, y: 0, w: 0.1, h: 0.1 }],
			quote: "Transformer",
			trigger: "selection",
		},
	});
	rememberPairedAskTranslation(thread.id, "第一句。");
	const request = pdfAskContextRequest(thread);
	expect(request.surface).toBe("quick_chat");
	expect(request.anchors[0]).toMatchObject({
		kind: "selection",
		paperPath: "papers/x",
		page: 3,
		quote: "Transformer",
		translation: "第一句。",
	});
});

it("turns sidebar selections and mentions into anchors without plaza paths", () => {
	const request = sidebarContextRequest({
		contextPaths: ["papers/attention", "agentero:plaza/today"],
		selectionAnnotations: new Map([["sel-1", 1]]),
		selections: [
			{
				id: "sel-1",
				text: "scaled dot-product",
				sourcePath: "papers/attention/paper.pdf",
				origin: "pdf",
				page: 4,
				comment: "看这里",
				pinned: true,
			},
		],
	});
	expect(request?.surface).toBe("sidebar");
	expect(request?.anchors).toEqual([
		expect.objectContaining({
			kind: "selection",
			filePath: "papers/attention/paper.pdf",
			page: 4,
			quote: "scaled dot-product",
			comment: "看这里",
			annotation: 1,
		}),
		{ kind: "mention", filePath: "papers/attention" },
	]);
});

it("keeps web, feed and chat evidence out of file access grants", () => {
	const selections = [
		{
			sourcePath: "https://example.org/paper",
			sourceUrl: "https://example.org/paper",
			origin: "markdown" as const,
		},
		{ sourcePath: "agentero:plaza/feeds/1", origin: "markdown" as const },
		{ sourcePath: "Chat session-1", origin: "chat" as const },
	].map((source, i) => ({
		...source,
		id: String(i),
		text: "evidence",
		pinned: true,
	}));
	expect(sidebarContextRequest({ contextPaths: [], selections })).toBeNull();
});
