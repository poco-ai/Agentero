import { describe, expect, it } from "vitest";
import {
	DefenseOutputValidationError,
	DefenseProviderDiagnosticError,
} from "@/lib/voice-defense/preparation/schema";
import { buildDefenseReviewMarkdown } from "@/lib/voice-defense/review/markdown";
import { buildSessionReviewPrompt } from "@/lib/voice-defense/review/prompts";
import { parseDefenseSessionReview } from "@/lib/voice-defense/review/schema";

const SOURCE = "papers/a/NOTES.md";

function reviewPayload(overrides: Record<string, unknown> = {}) {
	return {
		schemaVersion: 1,
		kind: "session-review",
		summary: "The candidate defended the experimental setup adequately.",
		overall: "adequate",
		turns: [
			{
				question: "Why three random seeds?",
				answer: "To report variance.",
				verdict: "adequate",
				factualErrors: [],
				notes: "Correct direction, thin on numbers.",
				evidence: [{ path: SOURCE, confidence: "high", page: 4 }],
			},
		],
		weakAreas: ["variance reporting"],
		suggestedMaterials: ["papers/a/source/ablation.tex"],
		sources: [{ path: SOURCE, confidence: "high" }],
		warnings: [],
		...overrides,
	};
}

describe("defense session review schema", () => {
	it("parses a valid review and rejects evidence outside the snapshot", () => {
		const review = parseDefenseSessionReview(JSON.stringify(reviewPayload()), [
			SOURCE,
		]);
		expect(review.kind).toBe("session-review");
		expect(review.overall).toBe("adequate");
		expect(review.turns).toHaveLength(1);
		expect(review.weakAreas).toEqual(["variance reporting"]);

		expect(() =>
			parseDefenseSessionReview(JSON.stringify(reviewPayload()), [
				"papers/other/NOTES.md",
			]),
		).toThrow(DefenseOutputValidationError);

		expect(() =>
			parseDefenseSessionReview(
				JSON.stringify(reviewPayload({ overall: "excellent" })),
				[SOURCE],
			),
		).toThrow(/overall/);
	});

	it("surfaces an ACP provider HTTP diagnostic instead of a JSON parser error", () => {
		const raw = [
			"Warning: Skill descriptions were shortened to fit the context budget.",
			"",
			'unexpected status 403 Forbidden: provider rejected the ACP client body={"error":"denied"}',
		].join("\n");
		expect(() => parseDefenseSessionReview(raw, [SOURCE])).toThrow(
			DefenseProviderDiagnosticError,
		);
		try {
			parseDefenseSessionReview(raw, [SOURCE]);
		} catch (error) {
			expect(error).toMatchObject({ statusCode: 403 });
			expect((error as Error).message).toContain("403 Forbidden");
			expect((error as Error).message).not.toMatch(
				/Unexpected (?:identifier|token)/,
			);
		}
	});

	it("recovers a review object embedded after warning text with braces", () => {
		const raw = [
			"Warning: adapter metadata {not JSON} was emitted before the result.",
			JSON.stringify(reviewPayload()),
		].join("\n");
		expect(parseDefenseSessionReview(raw, [SOURCE])).toMatchObject({
			kind: "session-review",
			overall: "adequate",
		});
	});

	it("renders a Vault review note with transcript and brief wikilinks", () => {
		const review = parseDefenseSessionReview(JSON.stringify(reviewPayload()), [
			SOURCE,
		]);
		const markdown = buildDefenseReviewMarkdown({
			title: "A paper",
			language: "zh-CN",
			transcriptPath: "voice-defense/20260808-090706.md",
			briefPath: "voice-defense/preparations/run-1/defense-brief.md",
			review,
		});
		expect(markdown).toContain("[[voice-defense/20260808-090706.md]]");
		expect(markdown).toContain(
			"[[voice-defense/preparations/run-1/defense-brief.md]]",
		);
		expect(markdown).toContain("薄弱环节");
		expect(markdown).toContain("variance reporting");
	});

	it("builds a read-only review prompt that pins allowed sources", () => {
		const prompt = buildSessionReviewPrompt({
			language: "zh-CN",
			brief: "# Defense Brief",
			captions: [
				{ id: "q1", role: "assistant", text: "Why three seeds?" },
				{ id: "a1", role: "user", text: "To report variance." },
			],
			questions: [],
			debrief: null,
			allowedSourcePaths: [SOURCE],
		});
		expect(prompt).toContain("只读");
		expect(prompt).toContain(SOURCE);
		expect(prompt).toContain("委员: Why three seeds?");
		expect(prompt).toContain("答辩人: To report variance.");
		expect(prompt).toContain("不修改任何文件");
	});
});
