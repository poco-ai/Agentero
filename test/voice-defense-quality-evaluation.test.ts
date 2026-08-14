// @ts-expect-error The evaluator is a Node-only ESM script and intentionally has no app bundle types.

import { describe, expect, it } from "vitest";
import {
	evaluateStudy,
	renderMarkdown,
} from "../scripts/evaluate-voice-defense.mjs";

const COVERAGE = {
	researchProblem: true,
	method: true,
	experiments: true,
	conclusions: true,
	limitations: true,
};

function variant(overrides: Record<string, unknown> = {}) {
	return {
		status: "completed",
		durationMs: 1_000,
		coverage: COVERAGE,
		evidence: { checked: 10, accurate: 9 },
		unsupportedClaims: { checked: 10, unsupported: 0 },
		questions: { checked: 10, distinct: 9, answerable: 9 },
		voice: { firstQuestionMs: 100, medianTurnMs: 200 },
		generatedTextPath: null,
		reviewedTextPath: null,
		...overrides,
	};
}

function study(
	single: Record<string, unknown> = {},
	multi: Record<string, unknown> = {},
) {
	return {
		schemaVersion: 1,
		studyId: "quality-test",
		papers: ["a", "b", "c"].map((id) => ({
			id,
			title: id,
			variants: {
				"single-agent": variant(single),
				"multi-agent": variant(multi),
			},
		})),
	};
}

describe("voice-defense quality evaluation", () => {
	it("aggregates fixed-corpus scores and recommends collaboration when quality improves", async () => {
		const result = await evaluateStudy(
			study(
				{ coverage: { ...COVERAGE, limitations: false } },
				{ durationMs: 2_000 },
			),
		);

		expect(result.aggregate["single-agent"].coverage).toBeCloseTo(0.8);
		expect(result.aggregate["multi-agent"].coverage).toBe(1);
		expect(result.recommendation).toBe("keep-multi-agent");
		expect(renderMarkdown(result)).toContain("Coverage");
		expect(renderMarkdown(result)).toContain("keep-multi-agent");
	});

	it("recommends an evidence checker when unsupported claims increase", async () => {
		const result = await evaluateStudy(
			study({}, { unsupportedClaims: { checked: 10, unsupported: 4 } }),
		);

		expect(result.recommendation).toBe("add-evidence-checker");
	});

	it("rejects incomplete coverage scores instead of silently treating them as zero", async () => {
		await expect(
			evaluateStudy(study({}, { coverage: { researchProblem: true } })),
		).rejects.toThrow(/missing boolean keys/);
	});
});
