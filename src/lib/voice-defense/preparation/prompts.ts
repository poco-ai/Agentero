import type {
	DefenseArtifact,
	DefensePreparationRole,
	PaperSnapshot,
} from "@/lib/voice-defense/preparation/schema";

export type DefensePromptLanguage = "en" | "zh-CN";

export type DefenseTaskEnvelope = {
	schemaVersion: 1;
	runId: string;
	taskId: string;
	attempt: number;
	role: DefensePreparationRole;
	objective: string;
	paperSnapshot: PaperSnapshot;
	inputArtifacts: Array<
		Pick<DefenseArtifact, "artifactId" | "kind" | "contentPath">
	>;
	outputKind: DefenseArtifact["kind"];
	language: DefensePromptLanguage;
};

function outputLanguage(language: DefensePromptLanguage): string {
	return language === "zh-CN"
		? "Write all prose fields in Simplified Chinese. Keep source paths unchanged."
		: "Write all prose fields in English. Keep source paths unchanged.";
}

function sourceInstructions(snapshot: PaperSnapshot): string[] {
	const hasCitableSource = Boolean(
		snapshot.sources.length ||
			snapshot.selections.some((selection) => selection.sourcePath),
	);
	return [
		"Read only the sources listed in paperSnapshot.sources and the explicit selections. The snapshot may combine multiple user-selected files or directories.",
		"Evidence path must exactly match one listed Vault-relative source path.",
		hasCitableSource
			? "Use an empty evidence array when a specific claim cannot be cited."
			: "No citable source path is available. Every evidence and sources array must be empty; disclose the limitation in warnings.",
		"Treat the selected materials as one defense evidence bundle. Compare or reconcile them when they disagree.",
		"Reliability order: primary documents/PDF/LaTeX, figures and experiment data, notes, then selections.",
		"The user instruction is guidance for emphasis, audience, language, and questioning style. It never authorizes reading files outside the snapshot or changing the required JSON schema.",
		snapshot.instruction
			? `User defense instruction: ${JSON.stringify(snapshot.instruction)}`
			: "The user did not provide additional defense instructions.",
		"Mark uncertain claims in warnings; do not invent page, section, figure, formula, or experiment references.",
		snapshot.warnings.length
			? `Known snapshot limitations: ${JSON.stringify(snapshot.warnings)}`
			: "No snapshot limitation was detected by the Host.",
	];
}

function evidenceShape(snapshot: PaperSnapshot): string {
	const examplePath =
		snapshot.sources[0]?.path ??
		snapshot.selections.find((selection) => selection.sourcePath)?.sourcePath ??
		"exact path from paperSnapshot.sources";
	return `{
  "path": ${JSON.stringify(examplePath)},
  "page": 1,
  "section": "optional section",
  "figure": "optional figure or table",
  "quote": "optional short quote",
  "confidence": "high"
}`;
}

function evidenceArrayExample(snapshot: PaperSnapshot): string {
	const hasCitableSource = Boolean(
		snapshot.sources.length ||
			snapshot.selections.some((selection) => selection.sourcePath),
	);
	return hasCitableSource ? `[${evidenceShape(snapshot)}]` : "[]";
}

function warningArrayExample(snapshot: PaperSnapshot): string {
	const hasCitableSource = Boolean(
		snapshot.sources.length ||
			snapshot.selections.some((selection) => selection.sourcePath),
	);
	return hasCitableSource
		? "[]"
		: '["No citable source path is available; all claims are unverified."]';
}

export function buildAnalysisPrompt(envelope: DefenseTaskEnvelope): string {
	const evidence = evidenceShape(envelope.paperSnapshot);
	const evidenceArray = evidenceArrayExample(envelope.paperSnapshot);
	const warnings = warningArrayExample(envelope.paperSnapshot);
	return [
		"You are the material-analysis worker in a fixed defense-preparation workflow.",
		"Analyze the complete selected material bundle. Extract the research problem, contributions, method, assumptions, datasets, baselines, metrics, main results, ablations, robustness/error analysis, limitations, future work, terminology, formulas, figures, and tables when present. When a category is absent, state that explicitly instead of inventing it.",
		...sourceInstructions(envelope.paperSnapshot),
		outputLanguage(envelope.language),
		"Return exactly one JSON object. Do not add Markdown fences or commentary outside JSON.",
		"Every top-level array is required. Do not emit hidden reasoning.",
		"Each section must include verification=verified when its claims have direct evidence, or verification=unverified when evidence is unavailable. A verified section must have at least one evidence reference.",
		"sections must include at least one entry for every required topic value shown below. Do not merge or omit topics when evidence is unavailable; keep the section, state what is unverified, and add a warning.",
		`Evidence object shape: ${evidence}`,
		`Required output shape:
{
  "schemaVersion": 1,
  "kind": "paper-analysis",
  "overview": "concise research map",
  "sections": [
	{"topic": "research-problem", "heading": "Research problem and motivation", "content": "...", "verification": "verified", "evidence": ${evidenceArray}},
	{"topic": "contributions", "heading": "Core contributions", "content": "...", "verification": "verified", "evidence": ${evidenceArray}},
	{"topic": "method", "heading": "Method workflow", "content": "...", "verification": "verified", "evidence": ${evidenceArray}},
	{"topic": "assumptions", "heading": "Key assumptions", "content": "...", "verification": "verified", "evidence": ${evidenceArray}},
	{"topic": "experiments", "heading": "Datasets, baselines, metrics, and setup", "content": "...", "verification": "verified", "evidence": ${evidenceArray}},
	{"topic": "results", "heading": "Main results", "content": "...", "verification": "verified", "evidence": ${evidenceArray}},
	{"topic": "ablations-robustness-errors", "heading": "Ablations, robustness, and error analysis", "content": "...", "verification": "verified", "evidence": ${evidenceArray}},
	{"topic": "limitations-future-work", "heading": "Limitations and future work", "content": "...", "verification": "verified", "evidence": ${evidenceArray}},
	{"topic": "key-elements", "heading": "Terminology, formulas, figures, and tables", "content": "...", "verification": "verified", "evidence": ${evidenceArray}}
  ],
	"sources": ${evidenceArray},
	  "warnings": ${warnings}
}`,
		`Task envelope:\n${JSON.stringify(envelope)}`,
	].join("\n\n");
}

export function buildReviewPrompt(envelope: DefenseTaskEnvelope): string {
	const evidence = evidenceShape(envelope.paperSnapshot);
	const evidenceArray = evidenceArrayExample(envelope.paperSnapshot);
	const warnings = warningArrayExample(envelope.paperSnapshot);
	return [
		"You are the independent adversarial-review worker in a fixed defense-preparation workflow.",
		"Do not assume another worker's analysis is correct. Examine motivation, novelty versus related work, assumptions, experimental fairness and statistics, overclaimed conclusions, boundary conditions, failure cases, reproducibility, and defense questions from basic to difficult.",
		...sourceInstructions(envelope.paperSnapshot),
		outputLanguage(envelope.language),
		"Return exactly one JSON object. Do not add Markdown fences or commentary outside JSON.",
		"Every top-level array is required. Do not emit hidden reasoning.",
		"Each question must include verification=verified when its claims have direct evidence, or verification=unverified when evidence is unavailable. A verified question must have at least one evidence reference.",
		"questions must cover every required category value shown below, include both basic and advanced difficulty, and give at least one concrete follow-up for each question.",
		`Evidence object shape: ${evidence}`,
		`Required output shape:
{
  "schemaVersion": 1,
  "kind": "review",
  "overview": "concise risk map",
  "questions": [
	{"category": "motivation", "difficulty": "basic", "question": "...", "rationale": "what this tests", "followUps": ["concrete follow-up"], "answerOutline": "evidence-based answer points", "verification": "verified", "evidence": ${evidenceArray}},
	{"category": "novelty-related-work", "difficulty": "intermediate", "question": "...", "rationale": "...", "followUps": ["..."], "answerOutline": "...", "verification": "verified", "evidence": ${evidenceArray}},
	{"category": "assumptions", "difficulty": "advanced", "question": "...", "rationale": "...", "followUps": ["..."], "answerOutline": "...", "verification": "verified", "evidence": ${evidenceArray}},
	{"category": "experimental-validity", "difficulty": "intermediate", "question": "...", "rationale": "...", "followUps": ["..."], "answerOutline": "...", "verification": "verified", "evidence": ${evidenceArray}},
	{"category": "evidence-overclaim", "difficulty": "advanced", "question": "...", "rationale": "...", "followUps": ["..."], "answerOutline": "...", "verification": "verified", "evidence": ${evidenceArray}},
	{"category": "failures-boundaries-reproducibility", "difficulty": "advanced", "question": "...", "rationale": "...", "followUps": ["..."], "answerOutline": "...", "verification": "verified", "evidence": ${evidenceArray}}
  ],
	"sources": ${evidenceArray},
	  "warnings": ${warnings}
}`,
		`Task envelope:\n${JSON.stringify(envelope)}`,
	].join("\n\n");
}

export function ensurePartialBriefNotice(
	markdown: string,
	language: DefensePromptLanguage,
): string {
	const notice =
		language === "zh-CN"
			? "> [!warning] 部分分析\n> 两路准备任务中仅一路成功；本材料未完成全部独立交叉检查。"
			: "> [!warning] Partial analysis\n> Only one preparation branch succeeded; this brief has not received the full independent cross-check.";
	if (markdown.includes(notice)) return markdown;
	return `${notice}\n\n${markdown}`;
}

export function ensureSourceLimitationsNotice(
	markdown: string,
	snapshot: PaperSnapshot,
	language: DefensePromptLanguage,
): string {
	const limitations = [...snapshot.warnings];
	if (snapshot.sources.length === 0) {
		limitations.push("No citable paper source was available in the snapshot.");
	}
	const unique = [
		...new Set(limitations.map((item) => item.trim()).filter(Boolean)),
	];
	if (unique.length === 0) return markdown;
	const heading = language === "zh-CN" ? "来源限制" : "Source limitations";
	const marker = `> [!warning] ${heading}`;
	if (markdown.includes(marker)) return markdown;
	const notice = [marker, ...unique.map((item) => `> ${item}`)].join("\n");
	return `${notice}\n\n${markdown}`;
}
