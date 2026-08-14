import type { DefenseDebrief } from "@/lib/voice-defense/debrief";
import type { DefensePromptLanguage } from "@/lib/voice-defense/preparation/prompts";
import type { DefenseQuestion } from "@/lib/voice-defense/preparation/schema";
import type { VoiceCaption } from "@/lib/voice-defense/protocol";

export function buildSessionReviewPrompt(input: {
	language: DefensePromptLanguage;
	brief: string;
	captions: readonly VoiceCaption[];
	questions: readonly DefenseQuestion[];
	debrief: DefenseDebrief | null;
	allowedSourcePaths: readonly string[];
}): string {
	const zh = input.language === "zh-CN";
	const transcript = input.captions
		.map((caption) => {
			const role =
				caption.role === "assistant"
					? zh
						? "委员"
						: "Committee"
					: zh
						? "答辩人"
						: "Candidate";
			return `${role}: ${caption.text.trim()}`;
		})
		.join("\n\n");
	const outline = input.questions
		.map(
			(question, index) =>
				`${index + 1}. [${question.difficulty}/${question.category}] ${question.question}\n   ${question.answerOutline}`,
		)
		.join("\n");
	const coverage = input.debrief
		? `${input.debrief.askedCount}/${input.debrief.totalCount}`
		: "n/a";
	const allowed = input.allowedSourcePaths.join("\n") || "(none)";
	return [
		zh
			? "你是只读的答辩评价委员。只根据提供的转写和答辩材料评价，不编造论文事实，不修改任何文件。"
			: "You are a read-only defense examiner. Grade only from the transcript and defense brief. Do not invent paper facts. Do not edit files.",
		zh
			? "确定性覆盖图只是提示（问没问到），必须以转写为准做语义对齐。"
			: "The deterministic coverage map is only a hint (asked or not). Align questions semantically against the transcript.",
		zh ? "用简体中文填写所有散文字段。" : "Write all prose fields in English.",
		"Allowed evidence paths (exact Vault-relative paths only):",
		allowed,
		"",
		"Return ONLY JSON with this shape:",
		JSON.stringify(
			{
				schemaVersion: 1,
				kind: "session-review",
				summary: zh ? "一段总评" : "one-paragraph overall assessment",
				overall: "strong|adequate|weak",
				turns: [
					{
						question: "committee question",
						answer: "candidate answer",
						verdict: "strong|adequate|weak|incorrect",
						factualErrors: ["optional factual error vs the brief"],
						notes: "why this verdict",
						evidence: [{ path: "exact path", confidence: "high" }],
					},
				],
				weakAreas: ["short topic"],
				suggestedMaterials: ["what to review next"],
				sources: [{ path: "exact path", confidence: "high" }],
				warnings: [],
			},
			null,
			2,
		),
		"",
		`Coverage hint: ${coverage}`,
		"",
		"--- BEGIN DEFENSE BRIEF ---",
		input.brief.trim() || "(empty)",
		"--- END DEFENSE BRIEF ---",
		"",
		"--- BEGIN PREPARED QUESTIONS ---",
		outline || "(none)",
		"--- END PREPARED QUESTIONS ---",
		"",
		"--- BEGIN TRANSCRIPT ---",
		transcript || "(empty)",
		"--- END TRANSCRIPT ---",
	].join("\n");
}
