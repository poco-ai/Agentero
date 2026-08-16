import { describe, expect, it } from "vitest";
import {
	captionCharsPerSecond,
	pacedCaptionLength,
	slicePacedCaption,
	VoiceCaptionPacer,
} from "@/lib/voice-defense/caption-pace";

describe("pacedCaptionLength", () => {
	it("shows the first glyph immediately and then follows speech time", () => {
		const text =
			"答辩现在开始。第一个问题：论文为什么认为仅用注意力替代循环和卷积是值得做的？请结合 Introduction 的动机回答。";
		expect(
			pacedCaptionLength({
				text,
				startedAtMs: 0,
				nowMs: 0,
				charsPerSec: 7,
			}),
		).toBe(1);
		expect(
			pacedCaptionLength({
				text,
				startedAtMs: 0,
				nowMs: 8_000,
				charsPerSec: 7,
			}),
		).toBe(56);
		expect(text.length).toBeGreaterThan(56);
	});

	it("does not dump a late ASR burst past the mouth position", () => {
		const burst =
			"答辩现在开始。第一个问题：论文为什么认为仅用注意力替代循环和卷积是值得做的？请结合 Introduction 回答。";
		expect(
			pacedCaptionLength({
				text: burst,
				startedAtMs: 0,
				nowMs: 4_000,
				charsPerSec: 7,
			}),
		).toBe(28);
		expect(burst.length).toBeGreaterThan(28);
	});

	it("follows small live ASR snapshots instead of holding one glyph", () => {
		expect(
			pacedCaptionLength({
				text: "答辩现在",
				startedAtMs: 0,
				nowMs: 0,
				charsPerSec: 7,
				shown: 1,
			}),
		).toBe(4);
	});

	it("never rewinds a length that was already shown", () => {
		expect(
			pacedCaptionLength({
				text: "x".repeat(40),
				startedAtMs: 0,
				nowMs: 0,
				charsPerSec: 7,
				shown: 20,
			}),
		).toBe(20);
	});

	it("flushes the remainder when the turn is over", () => {
		expect(
			pacedCaptionLength({
				text: "完整问题",
				startedAtMs: 0,
				nowMs: 0,
				flush: true,
			}),
		).toBe(4);
	});
});

describe("captionCharsPerSecond", () => {
	it("uses a slower rate for CJK than for Latin", () => {
		expect(captionCharsPerSecond("答辩现在开始")).toBe(7);
		expect(captionCharsPerSecond("The defense begins now")).toBe(16);
	});
});

describe("VoiceCaptionPacer", () => {
	it("keeps the stage behind a dumped committee caption until time catches up", () => {
		const pacer = new VoiceCaptionPacer();
		const text = "答辩现在开始。第一个问题：为什么注意力就够了？";
		pacer.push({ id: "q1", role: "assistant", text }, 0);
		expect(pacer.tick(0)[0]?.text).toBe("答");
		const visible = pacer.tick(2_000)[0]?.text ?? "";
		expect(visible).toBe(
			text.slice(0, pacedCaptionLength({ text, startedAtMs: 0, nowMs: 2_000 })),
		);
		expect(visible.length).toBeLessThan(text.length);
	});

	it("keeps an unused speaking mark after listening so late ASR can catch up", () => {
		const text = "答辩现在开始。第一个问题：为什么注意力就够了？";
		const kept = new VoiceCaptionPacer();
		kept.markSpeaking(0);
		kept.markIdle(1_000);
		kept.push({ id: "q1", role: "assistant", text }, 3_000);
		const late = new VoiceCaptionPacer();
		late.push({ id: "q1", role: "assistant", text }, 3_000);
		expect(kept.tick(3_000)[0]?.text.length).toBeGreaterThan(
			late.tick(3_000)[0]?.text.length ?? 0,
		);
	});

	it("starts the clock at speaking when that arrives before any caption", () => {
		const text = "答辩现在开始。第一个问题：为什么？";
		const pacer = new VoiceCaptionPacer();
		pacer.markSpeaking(0);
		pacer.push({ id: "q1", role: "assistant", text }, 3_000);
		const late = new VoiceCaptionPacer();
		late.push({ id: "q1", role: "assistant", text }, 3_000);
		expect(pacer.tick(3_000)[0]?.text.length).toBeGreaterThan(
			late.tick(3_000)[0]?.text.length ?? 0,
		);
	});

	it("anchors a gated caption to its first delta instead of emission time", () => {
		const text = "答辩现在开始。第一个问题：为什么注意力就够了？";
		// The caption reached the wire at t=0 but the opening gate only
		// released it to the stage at t=3000; crawling from glyph zero then
		// would leave the text seconds behind the audible voice.
		const gated = new VoiceCaptionPacer();
		gated.push({ id: "q1", role: "assistant", text, firstDeltaAt: 0 }, 3_000);
		const fresh = new VoiceCaptionPacer();
		fresh.push({ id: "q1", role: "assistant", text }, 3_000);
		expect((gated.tick(3_000)[0]?.text ?? "").length).toBeGreaterThan(
			(fresh.tick(3_000)[0]?.text ?? "").length,
		);
	});

	it("shows user captions in full and flushes the previous committee line", () => {
		const pacer = new VoiceCaptionPacer();
		pacer.push(
			{ id: "q1", role: "assistant", text: "第一个问题：为什么？" },
			0,
		);
		pacer.push({ id: "a1", role: "user", text: "因为自注意力。" }, 800);
		const staged = pacer.tick(800);
		expect(staged[0]?.text).toBe("第一个问题：为什么？");
		expect(staged[1]?.text).toBe("因为自注意力。");
	});

	it("retracts an emptied caption from the stage", () => {
		const pacer = new VoiceCaptionPacer();
		pacer.push({ id: "q1", role: "assistant", text: "答辩现在开始。" }, 0);
		pacer.push({ id: "q1", role: "assistant", text: "" }, 400);
		expect(pacer.tick(400)).toEqual([]);
	});

	it("flushes the latest assistant caption after idle debounce", () => {
		const text = "答辩现在开始。第一个问题：为什么注意力就够了？";
		const pacer = new VoiceCaptionPacer();
		pacer.markSpeaking(0);
		pacer.push({ id: "q1", role: "assistant", text }, 0);
		// At t=200 the text is still pacing — not yet idle-debounced.
		const before = pacer.tick(200)[0]?.text ?? "";
		expect(before.length).toBeLessThan(text.length);
		// Committee stops speaking.
		pacer.markIdle(200);
		// Within the 400ms debounce, text is still paced.
		const during = pacer.tick(400)[0]?.text ?? "";
		expect(during.length).toBeLessThan(text.length);
		// After the debounce (200 + 400 = 600ms), remaining text is flushed.
		const after = pacer.tick(700)[0]?.text ?? "";
		expect(after).toBe(text);
	});

	it("cancels idle catch-up when speaking resumes", () => {
		const text = "答辩现在开始。第一个问题：为什么注意力就够了？";
		const pacer = new VoiceCaptionPacer();
		pacer.markSpeaking(0);
		pacer.push({ id: "q1", role: "assistant", text }, 0);
		pacer.markIdle(200);
		// Speaking resumes before debounce fires.
		pacer.markSpeaking(300);
		const after = pacer.tick(700)[0]?.text ?? "";
		expect(after.length).toBeLessThan(text.length);
	});

	it("does not flush a new assistant turn using the previous turn's idle mark", () => {
		const text = "第二个问题：为什么实验需要三个随机种子？";
		const pacer = new VoiceCaptionPacer();
		pacer.markIdle(100);
		pacer.push({ id: "q2", role: "assistant", text }, 150);

		const staged = pacer.tick(600)[0]?.text ?? "";
		expect(staged.length).toBeLessThan(text.length);
	});
});

describe("slicePacedCaption", () => {
	it("reuses the caption object when the full text is visible", () => {
		const caption = { id: "q1", role: "assistant" as const, text: "完整" };
		expect(slicePacedCaption(caption, 2)).toBe(caption);
	});
});
