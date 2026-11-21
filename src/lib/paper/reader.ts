/**
 * paper-reader workflow: run the paper-reader skill against a paper folder,
 * surface progress via background tasks, mark catalog `is_read` on success.
 *
 * Skill activation syntax is provider-specific and owned entirely by the Host
 * (`skill_mention_style` + `paper_reader_skill_line`), which knows the resolved
 * agent template. This module must not restate it, or the two halves of the same
 * prompt can disagree about whether `$` / `/` activates anything.
 */

import i18n from "@/i18n";
import {
	type AgentFailedEvent,
	type AgentPlanEntry,
	type AgentPlanEvent,
	type AgentResultPayload,
	type AgentToolEvent,
	listAgents,
	listenAgentCompleted,
	listenAgentFailed,
	listenAgentPlan,
	listenAgentTool,
	type RunOnceAccepted,
	runOnce,
} from "@/lib/agent";
import { updateBackgroundTask } from "@/lib/core/background-tasks";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { runLocalActivity } from "@/lib/core/tasks";
import { isTauri } from "@/lib/core/tauri";
import { setPaperIsRead } from "@/lib/paper/api";
import { loadPaperMetadata } from "@/lib/paper/load-meta";
import { paperTaskLabel } from "@/lib/paper/task-label";
import { loadSettings } from "@/lib/settings";
import { resolveTranslateAgent } from "@/lib/translate";
import { joinVaultPath } from "@/lib/vault";
import { readVaultFile } from "@/lib/vault/fs";

const PAPER_READER_SKILL_ID = "paper-reader";

/** Reason a finished paper-reader run still failed its notes (#958). */
export type PaperReaderNotesProblem = "missing" | "unchanged" | "garbled";

/**
 * Gate the "mark read" step on what the run actually produced.
 *
 * Agents can end their session "completed" after writing garbage (Windows
 * code-page writes turn CJK into `?`) or after writing nothing at all (the
 * NOTES.md is still the import shell). Treating either as success hid the read
 * button with no way back (#958), so the workflow refuses to mark and stays
 * retryable instead.
 */
export function paperReaderNotesProblem(input: {
	before: string | null;
	after: string | null;
	/** Chinese body was requested (locale-driven, same rule as the prompt). */
	expectChinese: boolean;
}): PaperReaderNotesProblem | null {
	const { before, after, expectChinese } = input;
	if (after == null || !after.trim()) return "missing";
	if (after === before) return "unchanged";
	if (after.includes("�")) return "garbled";
	if (expectChinese) {
		const cjk = (after.match(/[一-鿿]/g) ?? []).length;
		// Chinese prose lost to '?' substitution keeps section structure but
		// leaves zero CJK behind and long '?' clusters where sentences were.
		const questionRuns = (after.match(/\?{3,}/g) ?? []).length;
		if (cjk === 0 && questionRuns >= 3) return "garbled";
	}
	return null;
}

/** Prevent concurrent reads of the same paper (auto + manual). */
const inflightReads = new Set<string>();

/**
 * Language line for paper-reader NOTES.md body, based on the resolved App
 * locale (`i18n.language` after settings load: `en` | `zh-CN`).
 * Fixed skill section headings come from the Chinese paper-reader skill; only
 * the body language changes.
 */
export function paperReaderLanguageInstruction(
	language: string = i18n.language,
): string {
	const lang = (language || "en").toLowerCase();
	if (lang.startsWith("zh")) {
		return "Write the NOTES.md body in Chinese (Simplified). Keep the fixed Chinese section headings from the skill (e.g. ## 方法).";
	}
	return "Write the NOTES.md body in English. Keep the fixed Chinese section headings from the skill (e.g. ## 方法).";
}

/**
 * User-facing request body: request facts only.
 *
 * Activation is Host-side — `build_prompt` states the syntax and
 * `skill_activation_prefix` prepends the native `$` / `/` trigger.
 */
export function buildPaperReaderUserPrompt(
	paperRel: string,
	language: string = i18n.language,
): string {
	return [
		`Paper folder (Vault-relative): \`${paperRel}\`.`,
		"Prefer TeX under source/, else PAPER.md, else local PDF.",
		`Write structured lecture notes into \`${paperRel}/NOTES.md\`.`,
		"Embed figures with Markdown image syntax whose src is relative to the paper folder (e.g. `source/figures/fig1.png`); never vault-prefix image srcs.",
		paperReaderLanguageInstruction(language),
		"Keep valid [[wikilinks]]. Use inline PDF fragment links or notes wikilinks for citations; do not add a trailing ## Sources block.",
	].join("\n");
}

/**
 * Agent seat for the background paper-reader run: the `paperReader` settings
 * seat (empty = default Agent + the model last picked for it).
 *
 * ACP sessions otherwise start on whatever model the Agent CLI defaults to
 * (for OpenCode that is a free Zen model), so the workflow has to pin the model
 * explicitly — same fallback the chat composer and the other seats resolve.
 */
async function resolvePaperReaderSeat(): Promise<{
	agentId?: string;
	modelId?: string;
}> {
	const registry = await listAgents().catch(() => null);
	return resolveTranslateAgent(loadSettings().paperReader, registry);
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
				finishErr(errorText(e));
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

	try {
		const paperAbs = joinVaultPath(opts.vaultRoot, paperRel);
		const notesAbs = joinVaultPath(opts.vaultRoot, `${paperRel}/NOTES.md`);
		// Snapshot before the run: an unchanged NOTES.md means the agent never
		// wrote anything; prior read state is restored if it self-marked.
		const notesBefore = await readVaultFile(notesAbs).catch(() => null);
		const wasRead =
			(await loadPaperMetadata(paperAbs, opts.vaultRoot).catch(() => null))
				?.is_read === true;

		await runLocalActivity(
			{
				kind: "paperRead",
				title: i18n.t("app:tasks.paperRead"),
				detail: paperTaskLabel(paperRel),
			},
			async ({ id, signal, setDetail }) => {
				setDetail(i18n.t("app:tasks.paperReadStarting"));

				const userPrompt = buildPaperReaderUserPrompt(paperRel);
				const seat = await resolvePaperReaderSeat();

				const accepted: RunOnceAccepted = await runOnce({
					agentId: seat.agentId,
					modelId: seat.modelId,
					vaultPath: opts.vaultRoot,
					workflow: "paper_reader",
					target: paperRel,
					prompt: userPrompt,
					skillIds: [PAPER_READER_SKILL_ID],
					permissionMode: "auto",
					// Background workflow — never surface in Agent chat history.
					hideFromChatHistory: true,
				});
				const cancelAgent = () => {
					void commands.agentCancelRun(accepted.sessionId);
				};
				if (signal.aborted) {
					cancelAgent();
					throw new Error(i18n.t("app:tasks.cancelled"));
				}
				signal.addEventListener("abort", cancelAgent, { once: true });

				setDetail(i18n.t("app:tasks.paperReadRunning"));
				await waitForAgentSession(accepted.sessionId, id);

				// Completed ≠ useful: verify NOTES.md actually changed and is not
				// mojibake before flipping the catalog read state (#958).
				const notesAfter = await readVaultFile(notesAbs).catch(() => null);
				const expectChinese = (i18n.language || "en")
					.toLowerCase()
					.startsWith("zh");
				const problem = paperReaderNotesProblem({
					before: notesBefore,
					after: notesAfter,
					expectChinese,
				});
				if (problem) {
					if (!wasRead) {
						// The agent may already have self-marked read via the CLI;
						// restore the unread state so the retry button comes back.
						await setPaperIsRead(opts.vaultRoot, paperRel, false).catch(
							() => undefined,
						);
					}
					throw new Error(
						problem === "garbled"
							? i18n.t("app:tasks.paperReadGarbled")
							: i18n.t("app:tasks.paperReadNoNotes"),
					);
				}

				setDetail(i18n.t("app:tasks.paperReadMarking"));
				await setPaperIsRead(opts.vaultRoot, paperRel, true);
				setDetail(i18n.t("app:tasks.paperReadDone"));
			},
		);
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
 * failures so callers can surface errors. Manual runs always use
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
