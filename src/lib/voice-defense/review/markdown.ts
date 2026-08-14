import type { DefenseSessionReview } from "@/lib/voice-defense/review/schema";

export function buildDefenseReviewMarkdown(input: {
	title: string;
	language: "en" | "zh-CN";
	transcriptPath: string;
	briefPath?: string;
	review: DefenseSessionReview;
}): string {
	const zh = input.language === "zh-CN";
	const overallLabel =
		input.review.overall === "strong"
			? zh
				? "扎实"
				: "strong"
			: input.review.overall === "weak"
				? zh
					? "薄弱"
					: "weak"
				: zh
					? "尚可"
					: "adequate";
	const lines = [
		`# ${zh ? "答辩评价" : "Defense review"}：${input.title}`,
		"",
		`- ${zh ? "转写" : "Transcript"}：[[${input.transcriptPath}]]`,
	];
	if (input.briefPath) {
		lines.push(`- ${zh ? "提纲" : "Brief"}：[[${input.briefPath}]]`);
	}
	lines.push(`- ${zh ? "总评" : "Overall"}：${overallLabel}`, "");
	lines.push(`## ${zh ? "摘要" : "Summary"}`, "", input.review.summary, "");
	if (input.review.weakAreas.length > 0) {
		lines.push(`## ${zh ? "薄弱环节" : "Weak areas"}`, "");
		for (const area of input.review.weakAreas) {
			lines.push(`- ${area}`);
		}
		lines.push("");
	}
	if (input.review.suggestedMaterials.length > 0) {
		lines.push(`## ${zh ? "建议补充" : "Suggested materials"}`, "");
		for (const item of input.review.suggestedMaterials) {
			lines.push(`- ${item}`);
		}
		lines.push("");
	}
	lines.push(`## ${zh ? "逐题评价" : "Turn-by-turn"}`, "");
	for (const turn of input.review.turns) {
		lines.push(`### ${turn.question}`, "");
		lines.push(
			`- ${zh ? "判定" : "Verdict"}：${turn.verdict}`,
			`- ${zh ? "回答" : "Answer"}：${turn.answer}`,
			`- ${zh ? "评语" : "Notes"}：${turn.notes}`,
		);
		if (turn.factualErrors.length > 0) {
			lines.push(`- ${zh ? "事实错误" : "Factual errors"}：`);
			for (const error of turn.factualErrors) {
				lines.push(`  - ${error}`);
			}
		}
		if (turn.evidence.length > 0) {
			lines.push(
				`- ${zh ? "证据" : "Evidence"}：${turn.evidence.map((item) => `[[${item.path}]]`).join("、")}`,
			);
		}
		lines.push("");
	}
	return `${lines.join("\n").trim()}\n`;
}
