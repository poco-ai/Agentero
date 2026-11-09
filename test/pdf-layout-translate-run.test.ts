import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyLayoutTranslateSidecar,
	type LayoutTranslateItem,
	type LayoutTranslateSidecar,
	runLayoutRegionTranslate,
} from "@/lib/pdf/layout/layout-translate";
import { runLayoutRegionTranslate as runPublicLayoutTranslate } from "@/lib/pdf/layout/layout-translate-reliable";
import { paragraphFromCharacters } from "@/lib/pdf/reflow/extract";
import { validReflowTranslation } from "@/lib/pdf/reflow/types";

const runTranslate = vi.fn<(...args: unknown[]) => Promise<string>>();

vi.mock("@/lib/translate", () => ({
	runTranslate: (...args: unknown[]) => runTranslate(...args),
}));

vi.mock("@/lib/settings", () => ({
	loadSettings: () => ({
		translate: {
			provider: "googleapi",
			targetLang: "zh-CN",
			sourceLang: "auto",
			providerConfigs: {},
			autoTranslateSelection: false,
			agentId: "",
			modelId: "",
		},
	}),
}));

function item(
	id: string,
	source: string,
	pageIndex: number,
	kind: LayoutTranslateItem["kind"] = "text",
): LayoutTranslateItem {
	return {
		id,
		pageIndex,
		bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.1 },
		kind,
		readingOrder: 0,
		source,
		status: "pending",
	};
}

describe("runLayoutRegionTranslate paragraph chains", () => {
	beforeEach(() => {
		runTranslate.mockReset();
	});

	it("keeps separate reflow sentence pairs and preserves their formula and style tokens", async () => {
		const reflow = paragraphFromCharacters(
			"p",
			0,
			{ x: 0, y: 0, w: 100, h: 40 },
			[],
			[],
			false,
		);
		reflow.source = "Use x here. Bold follows. Last sentence.";
		reflow.protectedText =
			"Use ⟪F0⟫ here. ⟪S0⟫Bold⟪/S0⟫ follows. Last sentence.";
		reflow.formulas = [
			{
				id: "0",
				text: "x",
				box: { x: 0, y: 0, w: 5, h: 5 },
				characterIndexes: [4],
				baselineOffset: 0,
			},
		];
		reflow.styles = { "0": { ...reflow.style, bold: true } };
		runTranslate.mockResolvedValueOnce(
			"[[1]] 使用 ⟦0⟧。\n[[2]] 接着是⟦0⟧粗体⟦1⟧。\n[[3]] 末句。",
		);
		const [translated] = await runLayoutRegionTranslate({
			items: [
				{ ...item("p", reflow.protectedText, 0), raw: reflow.source, reflow },
			],
			onUpdate: () => {},
		});
		expect(translated.status).toBe("done");
		expect(
			translated.sentences?.map(({ quote, translated }) => [quote, translated]),
		).toEqual([
			["Use x here.", "使用 ⟪F0⟫。"],
			["Bold follows.", "接着是⟪S0⟫粗体⟪/S0⟫。"],
			["Last sentence.", "末句。"],
		]);
		expect(validReflowTranslation(reflow, translated.translated ?? "")).toBe(
			true,
		);

		const sidecar: LayoutTranslateSidecar = {
			schemaVersion: 2,
			source: {
				mode: "pdf-layout-translate",
				generatedAt: "",
				providerId: "googleapi",
				sourceLang: "en",
				targetLang: "zh-CN",
				serviceKey: "",
			},
			items: [
				{
					...translated,
					translated: translated.translated ?? "",
					sentences: [
						{
							quote: reflow.source,
							source: reflow.protectedText,
							translated: translated.translated ?? "",
						},
					],
				},
			],
		};
		expect(
			applyLayoutTranslateSidecar([translated], sidecar, {
				requireReflowSentencePairs: true,
			})[0],
		).toMatchObject({
			status: "pending",
			translated: undefined,
			sentences: undefined,
		});
		sidecar.items[0].sentences = translated.sentences;
		expect(
			applyLayoutTranslateSidecar([translated], sidecar, {
				requireReflowSentencePairs: true,
			})[0],
		).toMatchObject({ status: "done", sentences: translated.sentences });
	});

	it("publishes valid batch results before a different paragraph finishes retrying", async () => {
		let finishRetry!: (text: string) => void;
		runTranslate.mockResolvedValueOnce("[[1]] 参见网址。\n\n[[2]] 第二段。");
		runTranslate.mockImplementationOnce(
			() =>
				new Promise<string>((resolve) => {
					finishRetry = resolve;
				}),
		);
		const updates: LayoutTranslateItem[][] = [];
		const run = runLayoutRegionTranslate({
			items: [
				item("retry", "See https://example.com/x for details.", 0),
				item("ready", "Second standalone paragraph.", 0),
			],
			onUpdate: (items) => updates.push(items),
		});
		await vi.waitFor(() => expect(finishRetry).toBeTypeOf("function"));
		expect(
			updates.some(
				(items) => items[1].status === "done" && items[0].status === "running",
			),
		).toBe(true);
		finishRetry("参见 ⟦0⟧ 获取细节。");
		expect((await run).map((item) => item.status)).toEqual(["done", "done"]);
	});

	it("preserves raw quotes and source styles through the public long-block path", async () => {
		const raw = `A repre- sentation ${"with detail ".repeat(600)}ends here.`;
		const source = raw.replace("repre- sentation", "representation");
		runTranslate.mockImplementation(async (task) =>
			(task as { text: string }).text.trim(),
		);
		const sourceStyle = { fontSize: 0.0125, bold: false, italic: false };
		const out = await runPublicLayoutTranslate({
			items: [{ ...item("long", source, 0), raw, sourceStyle }],
			onUpdate: () => {},
		});
		expect(out).toHaveLength(1);
		expect(out[0]?.id).toBe("long");
		expect(out[0]?.kind).toBe("text");
		expect(out[0]?.sourceStyle).toEqual(sourceStyle);
		expect(out[0]?.sentences?.[0]?.quote).toBe(raw);
		expect(out[0]?.translated).toContain("ends here.");
	});

	it("sends a cross-page paragraph as one request and splits the result back", async () => {
		runTranslate.mockResolvedValue("智能体查询环境。随后它更新自己的策略。");
		const items = [
			item("a", "the agent queries the", 0),
			item("b", "environment and then updates its policy.", 1),
		];

		const out = await runLayoutRegionTranslate({ items, onUpdate: () => {} });

		expect(runTranslate).toHaveBeenCalledTimes(1);
		expect(runTranslate.mock.calls[0]?.[0]).toMatchObject({
			text: "the agent queries the environment and then updates its policy.",
		});
		expect(out.map((it) => it.status)).toEqual(["done", "done"]);
		expect(out[0]?.translated).toBe("智能体查询环境。");
		expect(out[1]?.translated).toBe("随后它更新自己的策略。");
		const quote =
			"the agent queries the environment and then updates its policy.";
		expect(out[0]?.sentences?.[0]).toMatchObject({
			quote,
			translated: "智能体查询环境。随后它更新自己的策略。",
			display: "智能体查询环境。",
		});
		expect(out[1]?.sentences?.[0]).toMatchObject({
			quote,
			display: "随后它更新自己的策略。",
		});
	});

	it("skips chains already cached and keeps independent paragraphs separate", async () => {
		runTranslate.mockResolvedValue("[[1]] 第一段。\n\n[[2]] 第二段。");
		const items = [
			{
				...item("cached", "Already translated.", 0),
				status: "done" as const,
				translated: "已翻译。",
			},
			item("a", "First standalone paragraph.", 0),
			item("b", "Second standalone paragraph.", 0),
		];

		const out = await runLayoutRegionTranslate({ items, onUpdate: () => {} });

		expect(runTranslate).toHaveBeenCalledTimes(1);
		const payload = runTranslate.mock.calls[0]?.[0] as { text: string };
		expect(payload.text).toContain("[[1]] First standalone paragraph.");
		expect(payload.text).toContain("[[2]] Second standalone paragraph.");
		expect(payload.text).not.toContain("Already translated.");
		expect(out.map((it) => it.translated)).toEqual([
			"已翻译。",
			"第一段。",
			"第二段。",
		]);
	});

	it("retries with protection intact when the engine drops a placeholder", async () => {
		runTranslate
			.mockResolvedValueOnce("参见 网址 获取细节。")
			.mockResolvedValueOnce("参见 ⟦0⟧ 获取细节。");
		const items = [item("a", "See https://example.com/x for details.", 0)];

		const out = await runLayoutRegionTranslate({ items, onUpdate: () => {} });

		expect(runTranslate).toHaveBeenCalledTimes(2);
		expect(runTranslate.mock.calls[1]?.[0]).toMatchObject({
			text: "See ⟦0⟧ for details.",
		});
		expect(out[0]?.translated).toBe("参见 https://example.com/x 获取细节。");
		expect(out[0]?.sentences?.[0]?.quote).toBe(
			"See https://example.com/x for details.",
		);
	});

	it("does not publish a translation with damaged formulas after retry", async () => {
		runTranslate.mockResolvedValue("公式 ⟦0⟧ ⟦0⟧");
		const out = await runLayoutRegionTranslate({
			items: [item("math", "Use $x^2$ now.", 0)],
			onUpdate: () => {},
		});
		expect(runTranslate).toHaveBeenCalledTimes(2);
		expect(out[0]?.status).toBe("error");
		expect(out[0]?.translated).toBeUndefined();
	});

	it("sends all of a long sentence within the transport budget and retains its anchor", async () => {
		const source = `${"longword ".repeat(1100)}END.`;
		runTranslate.mockImplementation(async (task) =>
			(task as { text: string }).text.trim(),
		);
		const out = await runLayoutRegionTranslate({
			items: [item("long", source, 0)],
			onUpdate: () => {},
		});
		expect(runTranslate.mock.calls.length).toBeGreaterThan(1);
		for (const call of runTranslate.mock.calls)
			expect((call[0] as { text: string }).text.length).toBeLessThanOrEqual(
				4500,
			);
		expect(out[0]?.translated).toContain("END.");
		expect(out[0]?.sentences?.[0]?.quote).toBe(source);
		expect(out[0]?.status).toBe("done");
	});

	it("numbers each sentence and stores the pair on the block", async () => {
		runTranslate.mockResolvedValue("[[1]] 第一句。\n\n[[2]] 第二句。");
		const items = [item("a", "First sentence. Second sentence.", 0)];

		const out = await runLayoutRegionTranslate({ items, onUpdate: () => {} });

		const payload = runTranslate.mock.calls[0]?.[0] as { text: string };
		expect(payload.text).toContain("[[1]] First sentence.");
		expect(payload.text).toContain("[[2]] Second sentence.");
		expect(out[0]?.status).toBe("done");
		expect(out[0]?.translated).toBe("第一句。第二句。");
		expect(out[0]?.sentences).toEqual([
			{
				quote: "First sentence.",
				source: "First sentence.",
				translated: "第一句。",
			},
			{
				quote: "Second sentence.",
				source: "Second sentence.",
				translated: "第二句。",
			},
		]);
	});

	it("retries each sentence when markers are merged and skips pairs if one fails", async () => {
		runTranslate
			.mockResolvedValueOnce("第一句第二句。")
			.mockResolvedValueOnce("第一句。")
			.mockRejectedValueOnce(new Error("nope"));
		const items = [item("a", "First sentence. Second sentence.", 0)];

		const out = await runLayoutRegionTranslate({ items, onUpdate: () => {} });

		expect(runTranslate).toHaveBeenCalledTimes(3);
		expect(out[0]?.status).toBe("error");
		expect(out[0]?.sentences).toBeUndefined();
		expect(out[0]?.translated).toBeUndefined();
	});
});

it("retries structural formulas with nonnumeric placeholders when MT interprets token IDs as quantities", async () => {
	runTranslate.mockReset();
	const reflow = paragraphFromCharacters(
		"p",
		0,
		{ x: 0, y: 0, w: 100, h: 30 },
		[],
		[],
		false,
	);
	reflow.source = "Factor x";
	reflow.protectedText = "Factor ⟪F0⟫";
	reflow.formulas = [
		{
			id: "0",
			text: "x",
			box: { x: 0, y: 0, w: 5, h: 10 },
			characterIndexes: [0],
			baselineOffset: 0,
		},
	];
	runTranslate
		.mockResolvedValueOnce("倍数 0")
		.mockImplementation(async (task) =>
			(task as { text: string }).text.replace("Factor", "倍数"),
		);
	const out = await runLayoutRegionTranslate({
		items: [{ ...item("p", reflow.protectedText, 0), reflow }],
		onUpdate: () => {},
	});
	expect(out[0].status).toBe("done");
	expect(out[0].translated).toContain("⟪F0⟫");
	expect(runTranslate.mock.calls[1]?.[0]).toMatchObject({
		text: "Factor ZXQAQXZ",
	});
});
it.each([
	false,
	true,
])("retains style order when prose batch markers are damaged: %s", async (damaged) => {
	runTranslate.mockReset();
	const reflow = paragraphFromCharacters(
		"p",
		0,
		{ x: 0, y: 0, w: 100, h: 30 },
		[],
		[],
		false,
	);
	reflow.source = ". A word";
	reflow.protectedText = ". A ⟪S0⟫word⟪/S0⟫";
	reflow.styles = { "0": { ...reflow.style, bold: true } };
	runTranslate
		.mockResolvedValueOnce("坏结果")
		.mockResolvedValueOnce("坏结果")
		.mockResolvedValueOnce(damaged ? "一个词" : "[[1]] 一个\n\n[[2]] 词")
		.mockResolvedValueOnce("一个")
		.mockResolvedValueOnce("词");
	const out = await runLayoutRegionTranslate({
		items: [{ ...item("p", reflow.protectedText, 0), reflow }],
		onUpdate: () => {},
	});
	expect(out[0].status).toBe("done");
	expect(out[0].reflowFallback).toBe("protected-spans");
	expect(runTranslate).toHaveBeenCalledTimes(damaged ? 5 : 3);
	expect(runTranslate.mock.calls[2]?.[0]).toMatchObject({
		text: "[[1]] A \n\n[[2]] word",
	});
	expect(out[0].translated).toContain(". 一个");
	expect(out[0].translated).toContain("⟪S0⟫ 词 ⟪/S0⟫");
});
