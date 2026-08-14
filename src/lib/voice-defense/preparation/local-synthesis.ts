/**
 * Deterministic local synthesis of the defense brief.
 *
 * The analysis and adversarial-review workers already produce fully validated,
 * evidence-checked structured payloads. Rendering them into the brief is a
 * formatting job, not a reasoning job — doing it locally removes the third
 * (and previously slowest) ACP round-trip from every preparation run, and a
 * template cannot hallucinate content that the validated payloads do not hold.
 */

import type { DefensePromptLanguage } from "@/lib/voice-defense/preparation/prompts";
import {
	ensurePartialBriefNotice,
	ensureSourceLimitationsNotice,
} from "@/lib/voice-defense/preparation/prompts";
import type {
	AdversarialReviewOutput,
	DefenseArtifact,
	DefenseBriefOutput,
	DefenseQuestion,
	EvidenceRef,
	PaperAnalysisOutput,
	PaperSnapshot,
} from "@/lib/voice-defense/preparation/schema";
import { DEFENSE_PREPARATION_SCHEMA_VERSION } from "@/lib/voice-defense/preparation/schema";

const STRINGS = {
	en: {
		title: "# Defense Brief",
		researchMap: "## Research map",
		questions: "## Committee questions and answer prep",
		sourcesHeading: "## Cited sources",
		evidence: "Evidence",
		unverified: "Unverified — no direct evidence in the material",
		rationale: "What this tests",
		followUps: "Likely follow-ups",
		answerOutline: "Answer points",
		page: "p.",
		difficulty: {
			basic: "basic",
			intermediate: "intermediate",
			advanced: "advanced",
		},
	},
	"zh-CN": {
		title: "# 答辩提纲",
		researchMap: "## 研究地图",
		questions: "## 委员质疑与应答准备",
		sourcesHeading: "## 引用来源",
		evidence: "证据位置",
		unverified: "未经证据核实 — 材料中没有直接依据",
		rationale: "考察点",
		followUps: "可能的追问",
		answerOutline: "应答要点",
		page: "第",
		difficulty: {
			basic: "基础",
			intermediate: "进阶",
			advanced: "高阶",
		},
	},
} as const;

const QUESTION_CATEGORY_LABELS: Record<
	DefenseQuestion["category"],
	{ en: string; "zh-CN": string }
> = {
	motivation: { en: "Motivation", "zh-CN": "研究动机" },
	"novelty-related-work": {
		en: "Novelty vs. related work",
		"zh-CN": "创新性与相关工作",
	},
	assumptions: { en: "Assumptions", "zh-CN": "假设" },
	"experimental-validity": {
		en: "Experimental validity",
		"zh-CN": "实验有效性",
	},
	"evidence-overclaim": {
		en: "Evidence and overclaiming",
		"zh-CN": "证据与结论边界",
	},
	"failures-boundaries-reproducibility": {
		en: "Failures, boundaries, reproducibility",
		"zh-CN": "失效、边界与可复现性",
	},
};

function formatEvidenceRef(
	ref: EvidenceRef,
	language: DefensePromptLanguage,
): string {
	const strings = STRINGS[language];
	const location = [
		ref.page !== undefined
			? language === "zh-CN"
				? `${strings.page} ${ref.page} 页`
				: `${strings.page}${ref.page}`
			: "",
		ref.section ? `§${ref.section}` : "",
		ref.figure ?? "",
	]
		.filter(Boolean)
		.join(" · ");
	const quote = ref.quote?.trim() ? ` — “${ref.quote.trim()}”` : "";
	return `\`${ref.path}\`${location ? ` (${location})` : ""}${quote}`;
}

function evidenceLines(
	evidence: EvidenceRef[],
	verification: "verified" | "unverified",
	language: DefensePromptLanguage,
): string[] {
	const strings = STRINGS[language];
	if (verification === "unverified" || evidence.length === 0) {
		return [`- ⚠ ${strings.unverified}`];
	}
	return evidence.map(
		(ref) => `- ${strings.evidence}: ${formatEvidenceRef(ref, language)}`,
	);
}

function analysisMarkdown(
	analysis: PaperAnalysisOutput,
	language: DefensePromptLanguage,
): string[] {
	const strings = STRINGS[language];
	const blocks: string[] = [strings.researchMap, "", analysis.overview.trim()];
	for (const section of analysis.sections) {
		blocks.push(
			"",
			`### ${section.heading.trim()}`,
			"",
			section.content.trim(),
			"",
			...evidenceLines(section.evidence, section.verification, language),
		);
	}
	return blocks;
}

function reviewMarkdown(
	review: AdversarialReviewOutput,
	language: DefensePromptLanguage,
): string[] {
	const strings = STRINGS[language];
	const blocks: string[] = [strings.questions, "", review.overview.trim()];
	review.questions.forEach((question, index) => {
		const category = QUESTION_CATEGORY_LABELS[question.category][language];
		const difficulty = strings.difficulty[question.difficulty];
		blocks.push(
			"",
			`### Q${index + 1} · ${category} · ${difficulty}`,
			"",
			question.question.trim(),
			"",
			`- ${strings.rationale}: ${question.rationale.trim()}`,
			`- ${strings.followUps}: ${question.followUps
				.map((item) => item.trim())
				.filter(Boolean)
				.join("；")}`,
			`- ${strings.answerOutline}: ${question.answerOutline.trim()}`,
			...evidenceLines(question.evidence, question.verification, language),
		);
	});
	return blocks;
}

function dedupeEvidence(refs: EvidenceRef[]): EvidenceRef[] {
	const seen = new Set<string>();
	const unique: EvidenceRef[] = [];
	for (const ref of refs) {
		const key = [ref.path, ref.page ?? "", ref.section ?? "", ref.figure ?? ""]
			.join("|")
			.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(ref);
	}
	return unique;
}

/**
 * Render the validated analysis artifacts into the final brief payload.
 * Output satisfies the same schema contract the ACP synthesis worker had to
 * meet (`parseDefenseStructuredOutput("synthesis", …)`); callers should still
 * run that validation as the single source of schema truth.
 */
export function composeLocalDefenseBrief(input: {
	artifacts: DefenseArtifact[];
	snapshot: PaperSnapshot;
	partial: boolean;
	language: DefensePromptLanguage;
}): DefenseBriefOutput {
	const analysis = input.artifacts.find(
		(
			artifact,
		): artifact is DefenseArtifact & { payload: PaperAnalysisOutput } =>
			artifact.payload?.kind === "paper-analysis",
	)?.payload;
	const review = input.artifacts.find(
		(
			artifact,
		): artifact is DefenseArtifact & { payload: AdversarialReviewOutput } =>
			artifact.payload?.kind === "review",
	)?.payload;
	if (!analysis && !review) {
		throw new Error("local synthesis requires at least one validated artifact");
	}

	const strings = STRINGS[input.language];
	const blocks: string[] = [strings.title];
	if (analysis) blocks.push("", ...analysisMarkdown(analysis, input.language));
	if (review) blocks.push("", ...reviewMarkdown(review, input.language));

	const sources = dedupeEvidence([
		...(analysis?.sources ?? []),
		...(review?.sources ?? []),
	]);
	if (sources.length > 0) {
		blocks.push(
			"",
			strings.sourcesHeading,
			"",
			...sources.map((ref) => `- ${formatEvidenceRef(ref, input.language)}`),
		);
	}

	const warnings = [
		...new Set(
			[
				...(analysis?.warnings ?? []),
				...(review?.warnings ?? []),
				...input.snapshot.warnings,
			]
				.map((item) => item.trim())
				.filter(Boolean),
		),
	];

	const markdown = ensureSourceLimitationsNotice(
		input.partial
			? ensurePartialBriefNotice(blocks.join("\n"), input.language)
			: blocks.join("\n"),
		input.snapshot,
		input.language,
	);

	return {
		schemaVersion: DEFENSE_PREPARATION_SCHEMA_VERSION,
		kind: "defense-brief",
		markdown,
		sources,
		warnings,
		partial: input.partial,
	};
}
