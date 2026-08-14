import { describe, expect, it } from "vitest";
import {
	buildDefenseDebrief,
	captionSimilarity,
	DEBRIEF_ASKED_THRESHOLD,
} from "../src/lib/voice-defense/debrief";
import type { DefenseQuestion } from "../src/lib/voice-defense/preparation/schema";
import type { VoiceCaption } from "../src/lib/voice-defense/protocol";

function question(text: string, outline = "Answer outline"): DefenseQuestion {
	return {
		category: "experimental-validity",
		difficulty: "intermediate",
		question: text,
		rationale: "rationale",
		followUps: ["follow up"],
		answerOutline: outline,
		verification: "verified",
		evidence: [{ path: "papers/a/NOTES.md", page: 3 }],
	};
}

function caption(
	role: VoiceCaption["role"],
	text: string,
	id = crypto.randomUUID(),
): VoiceCaption {
	return { id, role, text };
}

describe("voice defense debrief", () => {
	it("scores identical and unrelated text at the extremes", () => {
		expect(
			captionSimilarity(
				"Why did you choose three random seeds?",
				"Why did you choose three random seeds?",
			),
		).toBe(1);
		expect(
			captionSimilarity(
				"Why did you choose three random seeds?",
				"Tell me about your favourite dessert recipe.",
			),
		).toBeLessThan(DEBRIEF_ASKED_THRESHOLD);
	});

	it("treats a committee rephrasing as the same challenge, in Chinese too", () => {
		expect(
			captionSimilarity(
				"实验只用了三个随机种子，结果的方差是否可信？",
				"我想先问实验部分：你们只跑了三个随机种子，这样得到的方差可信吗？",
			),
		).toBeGreaterThanOrEqual(DEBRIEF_ASKED_THRESHOLD);
	});

	it("maps asked challenges to the user's spoken answer", () => {
		const prepared = [
			question("Why did you choose three random seeds for the experiments?"),
			question("How does the method scale to longer sequences?"),
		];
		const captions = [
			caption("assistant", "The defense has started."),
			caption(
				"assistant",
				"Why did you choose three random seeds for the experiments?",
			),
			caption("user", "Because the variance was already small,"),
			caption("user", "and compute was limited."),
			caption("assistant", "Understood. Let us move on."),
		];
		const debrief = buildDefenseDebrief(captions, prepared);
		expect(debrief.totalCount).toBe(2);
		expect(debrief.askedCount).toBe(1);
		const [asked, missed] = debrief.questions;
		expect(asked.asked).toBe(true);
		expect(asked.askedText).toContain("three random seeds");
		expect(asked.userAnswer).toBe(
			"Because the variance was already small, and compute was limited.",
		);
		expect(missed.asked).toBe(false);
		expect(missed.userAnswer).toBeUndefined();
	});

	it("returns an empty debrief for an empty outline", () => {
		const debrief = buildDefenseDebrief([caption("assistant", "Anything")], []);
		expect(debrief.totalCount).toBe(0);
		expect(debrief.askedCount).toBe(0);
	});
});
