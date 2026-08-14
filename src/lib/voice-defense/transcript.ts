import { joinFrontmatter, splitFrontmatter } from "@/lib/markdown/doc";
import {
	frontmatterInterior,
	parseFrontmatterProperties,
	wrapFrontmatter,
} from "@/lib/markdown/frontmatter";
import type { DefenseDebrief } from "@/lib/voice-defense/debrief";
import type { VoiceCaption, VoiceScenario } from "@/lib/voice-defense/protocol";

export const VOICE_DEFENSE_DIRECTORY = "voice-defense";
export const VOICE_TRANSCRIPT_KIND = "voice-defense-transcript";

export type VoiceTranscriptMeta = {
	kind: typeof VOICE_TRANSCRIPT_KIND;
	started: string;
	durationSeconds: number | null;
	materials: string[];
	preparationRun?: string;
	scenario?: VoiceScenario;
	language?: "en" | "zh-CN";
	coverage?: string;
	review?: string;
	weakAreas?: string[];
};

function localTimestamp(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function voiceTranscriptFileName(date: Date): string {
	const compact = localTimestamp(date).replace(/[-:]/g, "").replace(" ", "-");
	return `${compact}.md`;
}

export function voiceTranscriptReviewFileName(transcriptPath: string): string {
	return transcriptPath.replace(/\.md$/i, "-review.md");
}

function yamlScalar(value: string): string {
	if (value === "" || /[:#\n"'\\]|^\s|\s$/.test(value)) {
		return JSON.stringify(value);
	}
	return value;
}

function yamlList(items: readonly string[]): string {
	if (items.length === 0) return "[]";
	return `\n${items.map((item) => `  - ${yamlScalar(item)}`).join("\n")}`;
}

function isoLocal(date: Date): string {
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function serializeVoiceTranscriptFrontmatter(
	meta: VoiceTranscriptMeta,
): string {
	const lines = [
		`kind: ${VOICE_TRANSCRIPT_KIND}`,
		`started: ${yamlScalar(meta.started)}`,
	];
	if (meta.durationSeconds !== null) {
		lines.push(`durationSeconds: ${meta.durationSeconds}`);
	}
	lines.push(`materials:${yamlList(meta.materials)}`);
	if (meta.preparationRun) {
		lines.push(`preparationRun: ${yamlScalar(meta.preparationRun)}`);
	}
	if (meta.scenario) lines.push(`scenario: ${meta.scenario}`);
	if (meta.language) lines.push(`language: ${meta.language}`);
	if (meta.coverage) lines.push(`coverage: ${yamlScalar(meta.coverage)}`);
	if (meta.review) lines.push(`review: ${yamlScalar(meta.review)}`);
	if (meta.weakAreas && meta.weakAreas.length > 0) {
		lines.push(`weakAreas:${yamlList(meta.weakAreas)}`);
	}
	return wrapFrontmatter(lines.join("\n"));
}

function scalar(
	properties: Map<string, { kind: string; value: string; items: string[] }>,
	key: string,
): string | undefined {
	const property = properties.get(key);
	if (!property || property.kind === "list") return undefined;
	const value = property.value.trim();
	return value || undefined;
}

function list(
	properties: Map<string, { kind: string; value: string; items: string[] }>,
	key: string,
): string[] {
	const property = properties.get(key);
	if (!property) return [];
	if (property.kind === "list") return property.items;
	const value = property.value.trim();
	if (!value || value === "[]") return [];
	return [value];
}

export function parseVoiceTranscriptMeta(
	markdown: string,
): VoiceTranscriptMeta | null {
	const { frontmatter } = splitFrontmatter(markdown);
	const interior = frontmatterInterior(frontmatter);
	if (!interior) return null;
	const parsed = parseFrontmatterProperties(interior);
	if (!parsed.ok) return null;
	const properties = new Map(
		parsed.properties.map((property) => [property.key, property]),
	);
	if (scalar(properties, "kind") !== VOICE_TRANSCRIPT_KIND) return null;
	const started = scalar(properties, "started");
	if (!started) return null;
	const durationRaw = scalar(properties, "durationSeconds");
	const durationParsed =
		durationRaw && durationRaw !== "" ? Number(durationRaw) : null;
	const languageRaw = scalar(properties, "language");
	const language =
		languageRaw === "en" || languageRaw === "zh-CN" ? languageRaw : undefined;
	const scenarioRaw = scalar(properties, "scenario");
	const scenario =
		scenarioRaw === "defense" ||
		scenarioRaw === "seminar" ||
		scenarioRaw === "review" ||
		scenarioRaw === "interview"
			? scenarioRaw
			: undefined;
	return {
		kind: VOICE_TRANSCRIPT_KIND,
		started,
		durationSeconds:
			durationParsed !== null && Number.isFinite(durationParsed)
				? durationParsed
				: null,
		materials: list(properties, "materials"),
		preparationRun: scalar(properties, "preparationRun"),
		scenario,
		language,
		coverage: scalar(properties, "coverage"),
		review: scalar(properties, "review"),
		weakAreas: list(properties, "weakAreas"),
	};
}

export function withTranscriptReviewLink(
	markdown: string,
	reviewPath: string,
	weakAreas: readonly string[] = [],
): string {
	const meta = parseVoiceTranscriptMeta(markdown);
	const { body } = splitFrontmatter(markdown);
	if (!meta) return markdown;
	return joinFrontmatter(
		serializeVoiceTranscriptFrontmatter({
			...meta,
			review: reviewPath,
			weakAreas: [...weakAreas],
		}),
		body.startsWith("\n") ? body : body ? `\n${body}` : "",
	);
}

function evidenceLine(
	evidence: { path: string; page?: number }[],
	zh: boolean,
): string | null {
	if (evidence.length === 0) return null;
	const refs = evidence
		.map((item) =>
			item.page !== undefined
				? `[[${item.path}]] (${zh ? "第" : "p."}${item.page}${zh ? "页" : ""})`
				: `[[${item.path}]]`,
		)
		.join("、");
	return `- ${zh ? "证据位置" : "Evidence"}：${refs}`;
}

function debriefLines(debrief: DefenseDebrief, zh: boolean): string[] {
	const lines = [
		`## ${zh ? "复盘" : "Debrief"}`,
		"",
		`- ${zh ? "预期质疑覆盖" : "Prepared challenges covered"}：${debrief.askedCount} / ${debrief.totalCount}`,
		"",
	];
	const asked = debrief.questions.filter((entry) => entry.asked);
	const missed = debrief.questions.filter((entry) => !entry.asked);
	if (asked.length > 0) {
		lines.push(
			`### ${zh ? "已问到的预期质疑" : "Challenges that came up"}`,
			"",
		);
		for (const entry of asked) {
			lines.push(`#### ${entry.question.question}`, "");
			if (entry.askedText) {
				lines.push(
					`- ${zh ? "委员实际提问" : "Committee asked"}：${entry.askedText.trim()}`,
				);
			}
			lines.push(
				`- ${zh ? "你的回答" : "Your answer"}：${entry.userAnswer ?? (zh ? "（未捕获到回答）" : "(no answer captured)")}`,
			);
			lines.push(
				`- ${zh ? "准备的应答要点" : "Prepared answer outline"}：${entry.question.answerOutline}`,
			);
			const evidence = evidenceLine(entry.question.evidence, zh);
			if (evidence) lines.push(evidence);
			lines.push("");
		}
	}
	if (missed.length > 0) {
		lines.push(
			`### ${zh ? "未问到的预期质疑（建议复习）" : "Challenges not raised (worth revisiting)"}`,
			"",
		);
		for (const entry of missed) {
			lines.push(`#### ${entry.question.question}`, "");
			lines.push(
				`- ${zh ? "应答要点" : "Answer outline"}：${entry.question.answerOutline}`,
			);
			const evidence = evidenceLine(entry.question.evidence, zh);
			if (evidence) lines.push(evidence);
			lines.push("");
		}
	}
	return lines;
}

export function buildVoiceTranscriptMarkdown(input: {
	title: string;
	source: string;
	context: string;
	startedAt: Date;
	captions: VoiceCaption[];
	language: "en" | "zh-CN";
	debrief?: DefenseDebrief | null;
	durationSeconds?: number | null;
	materials?: string[];
	preparationRun?: string;
	scenario?: VoiceScenario;
}): string {
	const zh = input.language === "zh-CN";
	const coverage =
		input.debrief && input.debrief.totalCount > 0
			? `${input.debrief.askedCount}/${input.debrief.totalCount}`
			: undefined;
	const frontmatter = serializeVoiceTranscriptFrontmatter({
		kind: VOICE_TRANSCRIPT_KIND,
		started: isoLocal(input.startedAt),
		durationSeconds: input.durationSeconds ?? null,
		materials: input.materials ?? [],
		preparationRun: input.preparationRun,
		scenario: input.scenario,
		language: input.language,
		coverage,
	});
	const lines = [
		`# ${zh ? "论文答辩" : "Paper defense"}：${input.title || (zh ? "未命名论文" : "Untitled")}`,
		"",
		`- ${zh ? "时间" : "Started"}：${localTimestamp(input.startedAt)}`,
		`- ${zh ? "来源" : "Source"}：${input.source ? `[[${input.source}]]` : "Agentero Vault"}`,
		`- ${zh ? "入口" : "Entry"}：ChatGPT Web Voice`,
		"",
	];
	if (input.debrief && input.debrief.totalCount > 0) {
		lines.push(...debriefLines(input.debrief, zh));
	}
	lines.push(
		`## ${zh ? "答辩材料" : "Defense material"}`,
		"",
		input.context.trim(),
		"",
		`## ${zh ? "对话记录" : "Transcript"}`,
		"",
	);
	for (const caption of input.captions) {
		const role =
			caption.role === "user"
				? zh
					? "用户"
					: "User"
				: zh
					? "答辩委员"
					: "Committee";
		lines.push(`### ${role}`, "", caption.text.trim(), "");
	}
	return `${frontmatter}${lines.join("\n").trim()}\n`;
}
