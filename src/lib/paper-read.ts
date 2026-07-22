/**
 * paper-reader workflow: run the paper-reader skill against a paper folder,
 * surface progress via background tasks, mark catalog `is_read` on success.
 *
 * Skill activation syntax is provider-specific (Host also adapts):
 * - Codex: `$paper-reader`
 * - Claude ACP: `/paper-reader`
 * - others: Agentero injects SKILL.md body (no native $ / / trigger)
 */
import i18n from "@/i18n";
import {
	type AgentFailedEvent,
	type AgentPlanEntry,
	type AgentPlanEvent,
	type AgentResultPayload,
	type AgentTemplate,
	type AgentToolEvent,
	listAgents,
	listenAgentCompleted,
	listenAgentFailed,
	listenAgentPlan,
	listenAgentTool,
	type RunOnceAccepted,
	runOnce,
} from "@/lib/agent";
import { loadPaperMetadata } from "@/lib/paper-metadata";
import { setPaperIsRead } from "@/lib/papers-api";
import { loadSettings } from "@/lib/settings";
import { isTauri } from "@/lib/tauri";
import { joinVaultPath } from "@/lib/vault";
import {
	completeBackgroundTask,
	failBackgroundTask,
	startBackgroundTask,
	updateBackgroundTask,
} from "@/stores/background-tasks-store";

export const PAPER_READER_SKILL_ID = "paper-reader";

/** Prevent concurrent reads of the same paper (auto + Zap). */
const inflightReads = new Set<string>();

/** How this Agentero agent template expects skills to be named in the user prompt. */
export type SkillMentionStyle = "dollar" | "slash" | "injected";

export function skillMentionStyleForTemplate(
	template: AgentTemplate | string | null | undefined,
): SkillMentionStyle {
	switch (template) {
		case "claude-acp":
			return "slash";
		default:
			return "injected";
	}
}

export function formatSkillMention(
	skillId: string,
	style: SkillMentionStyle,
): string {
	switch (style) {
		case "dollar":
			return `$${skillId}`;
		case "slash":
			return `/${skillId}`;
		default:
			return `skill:${skillId}`;
	}
}

/**
 * User-facing request body. Host will additionally prefix native triggers
 * (e.g. `$paper-reader` for Codex) and inject SKILL.md by style.
 */
export function buildPaperReaderUserPrompt(
	paperRel: string,
	style: SkillMentionStyle,
): string {
	const mention = formatSkillMention(PAPER_READER_SKILL_ID, style);
	const skillLine =
		style === "dollar"
			? `Activate and follow ${mention} (this agent uses $skill-id syntax).`
			: style === "slash"
				? `Activate and follow ${mention} (this agent uses /skill-id syntax).`
				: `Follow the paper-reader skill instructions Agentero injects into this prompt (${mention}). Do not wait for a separate $ or / command.`;

	return [
		skillLine,
		`Paper folder (Vault-relative): \`${paperRel}\`.`,
		"Prefer TeX under source/, else PAPER.md, else local PDF.",
		`Write structured lecture notes into \`${paperRel}/NOTES.md\`.`,
		"Keep [[wikilinks]]. End with ## Sources listing Vault-relative paths you read.",
	].join("\n");
}

async function resolveDefaultAgentTemplate(): Promise<AgentTemplate | null> {
	try {
		const list = await listAgents();
		const id = list.defaultId;
		if (!id) return list.agents[0]?.template ?? null;
		return list.agents.find((a) => a.id === id)?.template ?? null;
	} catch {
		return null;
	}
}

function planDetail(entries: AgentPlanEntry[]): string {
	if (!entries.length) {
		return i18n.t("app:tasks.paperReadRunning");
	}
	const active = entries.find(
		(e) => e.status === "in_progress" || e.status === "pending",
	);
	return (
		active?.content?.trim() ||
		entries[entries.length - 1]?.content?.trim() ||
		i18n.t("app:tasks.paperReadRunning")
	);
}

/**
 * Wait for agent:completed / agent:failed for a sessionId.
 * Also forwards plan/tool progress into the background task.
 */
async function waitForAgentSession(
	sessionId: string,
	taskId: string,
): Promise<AgentResultPayload> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const unsubs: Array<() => void> = [];

		const cleanup = () => {
			for (const u of unsubs) {
				try {
					u();
				} catch {
					// ignore
				}
			}
		};

		const finishOk = (payload: AgentResultPayload) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(payload);
		};

		const finishErr = (error: string) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(new Error(error));
		};

		void (async () => {
			try {
				unsubs.push(
					await listenAgentCompleted((ev: AgentResultPayload) => {
						if (ev.sessionId !== sessionId) return;
						finishOk(ev);
					}),
				);
				unsubs.push(
					await listenAgentFailed((ev: AgentFailedEvent) => {
						if (ev.sessionId !== sessionId) return;
						finishErr(ev.error || i18n.t("app:tasks.paperReadFailed"));
					}),
				);
				unsubs.push(
					await listenAgentPlan((ev: AgentPlanEvent) => {
						if (ev.sessionId !== sessionId) return;
						updateBackgroundTask(taskId, {
							detail: planDetail(ev.entries ?? []),
						});
					}),
				);
				unsubs.push(
					await listenAgentTool((ev: AgentToolEvent) => {
						if (ev.sessionId !== sessionId) return;
						const title = ev.title?.trim();
						if (title) {
							updateBackgroundTask(taskId, {
								detail: title,
							});
						}
					}),
				);
			} catch (e) {
				finishErr(e instanceof Error ? e.message : String(e));
			}
		})();
	});
}

/**
 * Start paper-reader for a Vault-relative paper path.
 * Reports progress in the bottom-left background task floater.
 */
export async function runPaperReaderWorkflow(opts: {
	vaultRoot: string;
	/** Vault-relative paper folder, e.g. papers/1706.03762 */
	paperPath: string;
}): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("sidebar:fileTree.readDesktopOnly"));
	}
	const paperRel = opts.paperPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!paperRel) {
		throw new Error(i18n.t("sidebar:fileTree.readFailed"));
	}
	if (inflightReads.has(paperRel)) {
		return;
	}
	inflightReads.add(paperRel);

	const taskId = startBackgroundTask({
		kind: "paperRead",
		title: i18n.t("app:tasks.paperRead"),
		detail: paperRel,
		running: true,
		progress: null,
	});

	try {
		updateBackgroundTask(taskId, {
			detail: i18n.t("app:tasks.paperReadStarting"),
		});

		const template = await resolveDefaultAgentTemplate();
		const skillStyle = skillMentionStyleForTemplate(template);
		const userPrompt = buildPaperReaderUserPrompt(paperRel, skillStyle);

		const accepted: RunOnceAccepted = await runOnce({
			vaultPath: opts.vaultRoot,
			workflow: "paper_reader",
			target: paperRel,
			prompt: userPrompt,
			skillIds: [PAPER_READER_SKILL_ID],
			autoApprove: true,
			// Background workflow — never surface in Agent chat history.
			hideFromChatHistory: true,
		});

		updateBackgroundTask(taskId, {
			detail: i18n.t("app:tasks.paperReadRunning"),
		});

		await waitForAgentSession(accepted.sessionId, taskId);

		updateBackgroundTask(taskId, {
			detail: i18n.t("app:tasks.paperReadMarking"),
		});

		await setPaperIsRead(opts.vaultRoot, paperRel, true);

		completeBackgroundTask(taskId, i18n.t("app:tasks.paperReadDone"));
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e);
		failBackgroundTask(taskId, msg);
		throw e;
	} finally {
		inflightReads.delete(paperRel);
	}
}

/**
 * Whether local assets are enough to start paper-reader
 * (TeX, PAPER.md, or PDF — matching skill read order).
 */
export function paperAssetsReadyForReader(flags: {
	pdf?: boolean | null;
	tex?: boolean | null;
	paperMd?: boolean | null;
}): boolean {
	return Boolean(flags.tex || flags.paperMd || flags.pdf);
}

/**
 * After import / download: if Settings → Agent → auto paper-reader is on,
 * assets are ready, and catalog `is_read` is false, start paper-reader
 * (shows left-bottom progress). Returns true when a run started.
 *
 * Default setting is **off**. Does not throw on skip; rethrows agent/workflow
 * failures so callers can surface errors. Manual Zap always uses
 * {@link runPaperReaderWorkflow} directly.
 */
export async function maybeAutoRunPaperReader(opts: {
	vaultRoot: string;
	/** Vault-relative paper folder */
	paperPath: string;
	/** Caller-known asset flags after ingest */
	assetsReady: boolean;
}): Promise<boolean> {
	if (!opts.assetsReady || !isTauri()) return false;
	if (!loadSettings().autoPaperReader) return false;
	const paperRel = opts.paperPath.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!paperRel || inflightReads.has(paperRel)) return false;

	const abs = joinVaultPath(opts.vaultRoot, paperRel);
	try {
		const meta = await loadPaperMetadata(abs, opts.vaultRoot);
		if (meta?.is_read === true) return false;
	} catch {
		// No catalog row / unreadable — still try (workflow may work; mark may fail)
	}

	await runPaperReaderWorkflow({
		vaultRoot: opts.vaultRoot,
		paperPath: paperRel,
	});
	return true;
}
