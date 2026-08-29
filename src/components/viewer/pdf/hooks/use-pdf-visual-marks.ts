/**
 * Region-crop visual marks for the EmbedPDF viewer: framing a rectangle on the
 * page (⌘. or a layout-region hover), cropping it through PDFium, and turning
 * that crop into a note-only mark, an Agent composer chip, or a full
 * conversation pinned to the region.
 *
 * Its own hook because a visual mark is the only mark kind whose *content* is an
 * image. The framing → crop → draft state machine (`regionSelecting` →
 * `visualCropPending` → draft card) has no counterpart in the text clusters, and
 * every save / continue path has to carry the PNG bytes explicitly (through
 * `writePdfVisualTrace` / `loadPdfVisualTraceImage`) instead of re-deriving them
 * from a live selection.
 *
 * Boundaries:
 * - the draft card state (`visualDraftEditor`) is owned by
 *   {@link usePdfLayoutHover}, because it is mutually exclusive with the
 *   formula glossary card; this hook never sets it, it only asks that owner to
 *   open / close one (`openVisualDraftEditor` / `closeVisualDraftEditor`);
 * - the persisted mark array lives in {@link usePdfMarksIo}: setters and the
 *   mirror ref are injected, never re-declared here;
 * - card placement / hover lives in {@link usePdfCards}: this hook only opens
 *   visual cards and resets their chrome;
 * - `resolvePdfAskAgent` is owned by {@link usePdfAskThreads} so a pin chat and
 *   a text ask pick the same default agent seat;
 * - the pin modal chat and the right-rail Agent panel are one product session,
 *   so every turn goes through `agentSessionStore.requestTurn`.
 */

import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { PdfAskThreads } from "@/components/viewer/pdf/hooks/use-pdf-ask-threads";
import type {
	CardScreenPoint,
	VisualDraftEditorState,
} from "@/components/viewer/pdf/types";
import { cancelAgentRun } from "@/lib/agent";
import { agentSessionStore } from "@/lib/agent/agent-session-store";
import {
	addVisualDraft,
	type PdfVisualDraft,
} from "@/lib/agent/visual-context-store";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import {
	createNoteTrace,
	createRunningTraces,
	deletePdfVisualTrace,
	isVisualMarkKind,
	type PdfVisualSessionTrace,
	traceMessages,
	writePdfVisualTrace,
} from "@/lib/pdf/agent-trace";
import { loadPdfVisualTraceImage } from "@/lib/pdf/agent-trace/image";
import type { ActiveSelectionCard } from "@/lib/pdf/selection";
import { newTraceMessageId } from "@/lib/pdf-visual/ids";
import { setAgentPanelMounted } from "@/lib/shell/ui-store";
import {
	openRightTab,
	requestOpenAgentSession,
} from "@/lib/shell/ui-window-actions";

export type UsePdfVisualMarksOptions = {
	/** Sidecar root for `marks/<id>.json` (null for loose PDFs — nothing persists). */
	paperAbsPath: string | null;
	/** Vault-relative provenance stamped into new marks. */
	paperRelPath: string | null;
	/** Persisted visual marks; owned by {@link usePdfMarksIo}. */
	visualTracesRef: RefObject<PdfVisualSessionTrace[]>;
	setVisualTraces: Dispatch<SetStateAction<PdfVisualSessionTrace[]>>;
	upsertVisualTrace: (trace: PdfVisualSessionTrace) => void;
	/** Cards cluster; owned by {@link usePdfCards}. */
	openCard: (card: ActiveSelectionCard) => void;
	hideActiveCard: () => void;
	activeCardRef: RefObject<ActiveSelectionCard | null>;
	cardScreenRef: RefObject<CardScreenPoint | null>;
	setCardScreen: Dispatch<SetStateAction<CardScreenPoint | null>>;
	/** Ask cluster: same default agent seat as a text ask turn. */
	resolvePdfAskAgent: PdfAskThreads["resolvePdfAskAgent"];
	/**
	 * Draft card, owned by {@link usePdfLayoutHover} together with the formula
	 * glossary card so their mutual exclusivity cannot be split across files.
	 */
	visualDraftEditor: VisualDraftEditorState | null;
	closeVisualDraftEditor: () => void;
};

export type PdfVisualMarks = {
	visualError: string | null;
	/** Keep the just-created ⌘↵ card expanded until the user dismisses it. */
	visualCardExpanded: boolean;
	/** Draft editor save: note-only visual mark (no Agent thread). */
	handleVisualDraftSave: (comment: string) => void;
	/** Draft editor「加入侧边栏对话」: crop → Agent composer chip. */
	handleVisualAddToChat: (comment: string) => void;
	/** Draft editor ⌘/Ctrl+Enter: open the pin chat and start an Agent turn. */
	handleVisualSendNow: (comment: string) => void;
	/** Pin note mode: persist a comment edit on an existing mark. */
	handleVisualSaveComment: (comment: string) => void;
	/** Persist a comment by mark id (comment-rail in-place edit). */
	updateVisualComment: (id: string, comment: string) => void;
	/** Pin header「加入侧边栏对话」on an existing mark. */
	handleVisualAddToChatFromMark: () => void;
	/** Pin chat composer: continue the mark's conversation. */
	handleVisualContinue: (question: string) => void;
	/** Pin header delete. */
	handleDeleteVisualTrace: () => void;
	/** Pin header: move the mark's conversation into the right-rail panel. */
	handleOpenActiveVisualSession: () => void;
	handleStopVisualSession: () => void;
	/** Drop a mark from state + disk (also used by the imperative handle). */
	deleteVisualTraceById: (id: string) => void;
	/** Per-kind chrome reset when a visual card closes (wired into `usePdfCards`). */
	resetVisualCardChrome: () => void;
};

export function usePdfVisualMarks({
	paperAbsPath,
	paperRelPath,
	visualTracesRef,
	setVisualTraces,
	upsertVisualTrace,
	openCard,
	hideActiveCard,
	activeCardRef,
	cardScreenRef,
	setCardScreen,
	resolvePdfAskAgent,
	visualDraftEditor,
	closeVisualDraftEditor,
}: UsePdfVisualMarksOptions): PdfVisualMarks {
	const { t } = useTranslation("viewer");
	const [visualError, setVisualError] = useState<string | null>(null);
	/** Keep the just-created Cmd+Enter card expanded until the user dismisses it. */
	const [visualCardExpanded, setVisualCardExpanded] = useState(false);

	const resetVisualCardChrome = useCallback(() => {
		setVisualError(null);
		setVisualCardExpanded(false);
	}, []);

	/**
	 * Save from the region editor: note-only visual mark (no Agent thread).
	 * Same UX as text 批注备注 — it lives in the right-edge comment rail.
	 */
	const handleVisualDraftSave = useCallback(
		(comment: string) => {
			const draft = visualDraftEditor;
			if (!draft) return;
			const paperPath = paperRelPath || paperAbsPath || "paper";
			let mark: PdfVisualSessionTrace;
			try {
				mark = createNoteTrace({
					paperPath,
					page: draft.page,
					rects: [draft.region],
					comment,
					image: {
						data: draft.image.data,
						mimeType: draft.image.mimeType || "image/png",
					},
				});
			} catch {
				return;
			}
			closeVisualDraftEditor();
			upsertVisualTrace(mark);
			if (paperAbsPath) {
				void writePdfVisualTrace(paperAbsPath, mark).catch((error) => {
					console.warn("[visual-mark] save note failed", error);
					notifyError(errorText(error));
				});
			}
			// Note-only visual marks render in the comment rail, not as a pin card.
		},
		[
			visualDraftEditor,
			paperRelPath,
			paperAbsPath,
			closeVisualDraftEditor,
			upsertVisualTrace,
		],
	);

	/**
	 * Header「加入侧边栏对话」from the create editor: crop → Agent composer chip.
	 */
	const handleVisualAddToChat = useCallback(
		(comment: string) => {
			const draft = visualDraftEditor;
			if (!draft) return;
			closeVisualDraftEditor();
			addVisualDraft({
				paperPath: paperRelPath || paperAbsPath || "paper",
				paperAbsPath: paperAbsPath ?? undefined,
				page: draft.page,
				rects: [draft.region],
				comment,
				image: draft.image,
			});
			openRightTab("agent");
		},
		[visualDraftEditor, paperRelPath, paperAbsPath, closeVisualDraftEditor],
	);

	/**
	 * Pin modal chat is the same product session as the right-rail Agent panel.
	 * All turns go through agentSessionStore.requestTurn → panel send pipeline.
	 */
	const requestVisualAgentTurn = useCallback(
		(input: {
			trace: PdfVisualSessionTrace;
			text: string;
			visualDrafts?: PdfVisualDraft[];
			agentId?: string;
			modelId?: string;
		}) => {
			const { trace, text, visualDrafts, agentId, modelId } = input;
			setAgentPanelMounted(true);
			setVisualError(null);
			agentSessionStore.getState().requestTurn({
				text,
				visualTraceId: trace.id,
				paperAbsPath: paperAbsPath ?? undefined,
				agentId,
				modelId,
				title: text.trim() || trace.comment || t("pdfExplain.visualAnnotation"),
				providerSessionId: trace.agent?.providerSessionId,
				visualDrafts,
			});
		},
		[paperAbsPath, t],
	);

	/**
	 * ⌘/Ctrl+Enter from the region editor: open pin chat and start Agent turn.
	 * Leave mark.comment empty — the editor text is conversation, not a note;
	 * putting it in both comment and messages duplicates in wiki embeds.
	 */
	const handleVisualSendNow = useCallback(
		(comment: string) => {
			const draft = visualDraftEditor;
			if (!draft) return;
			const paperPath = paperRelPath || paperAbsPath || "paper";
			// Conversation body (never the annotation note). Empty input still
			// needs a user turn so the agent path has something to send.
			const promptText = comment.trim() || t("pdfExplain.visualAnnotation");
			const now = new Date().toISOString();
			const userMsg = {
				id: newTraceMessageId(),
				role: "user" as const,
				content: promptText,
				createdAt: now,
			};
			const [provisional] = createRunningTraces({
				paperPath,
				agentId: "pending",
				runtimeSessionId: "pending",
				messageId: "pending",
				items: [
					{
						page: draft.page,
						rects: [draft.region],
						// Note field stays empty; content lives in messages only.
						comment: "",
						image: {
							data: draft.image.data,
							mimeType: draft.image.mimeType || "image/png",
						},
						messages: [userMsg],
					},
				],
				createdAt: now,
			});
			if (!provisional) return;
			closeVisualDraftEditor();
			upsertVisualTrace(provisional);
			setVisualCardExpanded(true);
			setVisualError(null);
			cardScreenRef.current = draft.screen;
			setCardScreen(draft.screen);
			openCard({ kind: "visual", id: provisional.id });

			void (async () => {
				try {
					const resolved = await resolvePdfAskAgent();
					const agentId = resolved?.agentId;
					if (!agentId) {
						setVisualTraces((prev) =>
							prev.filter((tr) => tr.id !== provisional.id),
						);
						hideActiveCard();
						return;
					}
					const visualDraft: PdfVisualDraft = {
						id: provisional.id,
						paperPath,
						paperAbsPath: paperAbsPath ?? undefined,
						page: draft.page,
						rects: [draft.region],
						// Same rule as mark.comment: chip/note empty on direct chat.
						comment: "",
						image: {
							data: draft.image.data,
							mimeType: draft.image.mimeType || "image/png",
						},
					};
					requestVisualAgentTurn({
						trace: {
							...provisional,
							agent: {
								...(provisional.agent ?? {
									runtimeSessionId: "pending",
									messageId: "pending",
									status: "running" as const,
								}),
								agentId,
							},
						},
						text: promptText,
						visualDrafts: [visualDraft],
						agentId,
						modelId: resolved.modelId,
					});
				} catch (e) {
					const message =
						e instanceof Error ? e.message : t("pdfAsk.agentFailed");
					notifyError(message);
					setVisualError(message);
				}
			})();
		},
		[
			visualDraftEditor,
			paperRelPath,
			paperAbsPath,
			t,
			closeVisualDraftEditor,
			upsertVisualTrace,
			openCard,
			resolvePdfAskAgent,
			requestVisualAgentTurn,
			hideActiveCard,
			cardScreenRef,
			setCardScreen,
			setVisualTraces,
		],
	);

	/** Persist a comment by mark id (rail in-place edit or pin note mode). */
	const updateVisualComment = useCallback(
		(id: string, comment: string) => {
			const latest = visualTracesRef.current.find((tr) => tr.id === id);
			if (!latest) return;
			const next: PdfVisualSessionTrace = {
				...latest,
				comment: comment.trim(),
				updatedAt: new Date().toISOString(),
			};
			// Keep content invariant: need comment, agent, or crop image.
			if (
				!next.comment &&
				!next.agent &&
				!next.image?.path &&
				!next.image?.data
			) {
				return;
			}
			upsertVisualTrace(next);
			if (paperAbsPath) {
				void writePdfVisualTrace(paperAbsPath, next).catch((error) => {
					console.warn("[visual-mark] update comment failed", error);
					notifyError(errorText(error));
				});
			}
		},
		[paperAbsPath, upsertVisualTrace, visualTracesRef],
	);

	/** Persist comment edits from the pin note mode. */
	const handleVisualSaveComment = useCallback(
		(comment: string) => {
			const card = activeCardRef.current;
			const traceId = isVisualMarkKind(card?.kind) ? card.id : null;
			if (!traceId) return;
			updateVisualComment(traceId, comment);
		},
		[activeCardRef, updateVisualComment],
	);

	/** Header「加入侧边栏对话」from an existing visual mark pin. */
	const handleVisualAddToChatFromMark = useCallback(() => {
		const card = activeCardRef.current;
		const traceId = isVisualMarkKind(card?.kind) ? card.id : null;
		if (!traceId) return;
		const latest = visualTracesRef.current.find((tr) => tr.id === traceId);
		if (!latest) return;
		void (async () => {
			const image = await loadPdfVisualTraceImage(
				paperAbsPath ?? "",
				latest.image,
			);
			if (!image?.data) {
				notifyError(t("pdfExplain.cropFailed"));
				return;
			}
			addVisualDraft({
				id: latest.id,
				paperPath: latest.paperPath || paperRelPath || paperAbsPath || "paper",
				paperAbsPath: paperAbsPath ?? undefined,
				page: latest.page,
				rects: latest.rects,
				comment: latest.comment,
				image: {
					data: image.data,
					mimeType: image.mimeType || "image/png",
				},
			});
			openRightTab("agent");
		})();
	}, [paperAbsPath, paperRelPath, t, activeCardRef, visualTracesRef]);

	const handleVisualContinue = useCallback(
		(question: string) => {
			const card = activeCardRef.current;
			const traceId = isVisualMarkKind(card?.kind) ? card.id : null;
			if (!traceId) return;
			setVisualCardExpanded(true);
			void (async () => {
				try {
					const latest = visualTracesRef.current.find(
						(tr) => tr.id === traceId,
					);
					if (!latest) return;
					// Prefer live providerSessionId from shared agent session.
					const bound = agentSessionStore
						.getState()
						.findByVisualTraceId(traceId);
					const providerSessionId =
						bound?.providerSessionId ?? latest.agent?.providerSessionId;
					// Continue: stick to the agent that owns this session/mark.
					// New pins use resolvePdfAskAgent (default); do not re-resolve here
					// or a Grok default would load a Codex providerSessionId.
					const priorAgentId = latest.agent?.agentId;
					const markAgent =
						bound?.agentId?.trim() ||
						(priorAgentId && priorAgentId !== "pending" ? priorAgentId : null);
					let agentId = markAgent;
					let modelId: string | undefined;
					if (!agentId) {
						const resolved = await resolvePdfAskAgent();
						if (!resolved?.agentId) return;
						agentId = resolved.agentId;
						modelId = resolved.modelId;
					}
					const agent = {
						...(latest.agent ?? {
							agentId,
							runtimeSessionId: "pending",
							messageId: "pending",
							status: "running" as const,
						}),
						agentId,
						providerSessionId:
							providerSessionId ?? latest.agent?.providerSessionId,
					};
					// Note-only (or provisional) mark → first Agent turn must send the
					// crop as visualDrafts so the multimodal prompt includes the image.
					// Reuse the same mark id so createRunningTraces overwrites in place.
					const firstAgentAttach =
						!bound &&
						(!latest.agent ||
							latest.agent.agentId === "pending" ||
							latest.agent.runtimeSessionId === "pending");
					let visualDrafts: PdfVisualDraft[] | undefined;
					if (firstAgentAttach) {
						const image = await loadPdfVisualTraceImage(
							paperAbsPath ?? "",
							latest.image,
						);
						if (image?.data) {
							visualDrafts = [
								{
									id: latest.id,
									paperPath: latest.paperPath,
									paperAbsPath: paperAbsPath ?? undefined,
									page: latest.page,
									rects: latest.rects,
									comment: latest.comment,
									image: {
										data: image.data,
										mimeType: image.mimeType || "image/png",
									},
								},
							];
						}
					}
					requestVisualAgentTurn({
						trace: { ...latest, agent },
						text: question,
						agentId,
						modelId,
						visualDrafts,
					});
				} catch (e) {
					const message = errorText(e);
					notifyError(message);
					setVisualError(message);
				}
			})();
		},
		[
			resolvePdfAskAgent,
			requestVisualAgentTurn,
			paperAbsPath,
			activeCardRef,
			visualTracesRef,
		],
	);

	const deleteVisualTraceById = useCallback(
		(id: string) => {
			setVisualTraces((prev) => prev.filter((tr) => tr.id !== id));
			if (paperAbsPath) void deletePdfVisualTrace(paperAbsPath, id);
			if (
				isVisualMarkKind(activeCardRef.current?.kind) &&
				activeCardRef.current.id === id
			) {
				hideActiveCard();
			}
		},
		[paperAbsPath, hideActiveCard, activeCardRef, setVisualTraces],
	);

	const handleDeleteVisualTrace = useCallback(() => {
		const id = isVisualMarkKind(activeCardRef.current?.kind)
			? activeCardRef.current.id
			: null;
		if (id) deleteVisualTraceById(id);
		else hideActiveCard();
	}, [deleteVisualTraceById, hideActiveCard, activeCardRef]);

	const openVisualTraceSession = useCallback(
		async (trace: PdfVisualSessionTrace) => {
			// Note-only marks have no Agent session yet — stay on the pin card.
			if (!trace.agent) return;
			// Same session as the pin modal — activate it in the shared store.
			setAgentPanelMounted(true);
			const store = agentSessionStore.getState();
			const existing =
				store.findByVisualTraceId(trace.id) ||
				(trace.agent.providerSessionId
					? store.findByProviderSessionId(trace.agent.providerSessionId)
					: undefined);
			if (existing) {
				store.setActiveTabId(existing.id);
				store.setLines(existing.lines);
			} else {
				// Seed from mark once so sidebar opens the same transcript.
				const messages = traceMessages(trace);
				const image = await loadPdfVisualTraceImage(
					paperAbsPath ?? "",
					trace.image,
				);
				const title =
					messages.find((m) => m.role === "user")?.content.trim() ||
					trace.comment.trim() ||
					t("pdfExplain.visualAnnotation");
				const agentId =
					trace.agent.agentId === "pending" ? "" : trace.agent.agentId;
				requestOpenAgentSession({
					agentId,
					runtimeSessionId: trace.agent.runtimeSessionId,
					providerSessionId: trace.agent.providerSessionId,
					messageId: trace.agent.messageId,
					title,
					prompt: title,
					answerSnapshot: trace.agent.answerSnapshot,
					paperAbsPath: paperAbsPath ?? undefined,
					visualTrace: {
						traceId: trace.id,
						page: trace.page,
						comment: trace.comment,
						paperPath: trace.paperPath,
						...(image ? { image } : {}),
						messages: messages.map((m) => ({ ...m })),
						status: trace.agent.status,
					},
				});
			}
			openRightTab("agent");
			hideActiveCard();
		},
		[hideActiveCard, paperAbsPath, t],
	);

	/** Stable callbacks so VisualTraceCard memo can skip PdfViewer re-renders. */
	const handleOpenActiveVisualSession = useCallback(() => {
		const card = activeCardRef.current;
		if (!isVisualMarkKind(card?.kind)) return;
		const tr = visualTracesRef.current.find((item) => item.id === card.id);
		if (tr) void openVisualTraceSession(tr);
	}, [openVisualTraceSession, activeCardRef, visualTracesRef]);

	const handleStopVisualSession = useCallback(() => {
		// Shared agent session store is the source of truth after modal↔panel
		// unification.
		const store = agentSessionStore.getState();
		const card = activeCardRef.current;
		const traceId = isVisualMarkKind(card?.kind) ? card.id : null;
		const bound = traceId ? store.findByVisualTraceId(traceId) : undefined;
		const sid =
			bound?.id ||
			(store.submitting && store.activeTabId !== "draft"
				? store.activeTabId
				: null);
		if (sid && sid !== "draft") {
			void cancelAgentRun(sid).catch(() => undefined);
			store.setSessions((prev) =>
				prev.map((item) =>
					item.id === sid && item.status === "running"
						? { ...item, status: "cancelled" }
						: item,
				),
			);
		}
		// Also clear any other visual-bound sessions stuck as running (e.g.
		// after an ErrorBoundary crash mid-stream).
		if (traceId) {
			store.setSessions((prev) =>
				prev.map((item) =>
					"visualTraceId" in item &&
					(item as { visualTraceId?: string }).visualTraceId === traceId &&
					item.status === "running"
						? { ...item, status: "cancelled" }
						: item,
				),
			);
		}
		store.setSubmitting(false);
		setVisualError(null);
	}, [activeCardRef]);

	return {
		visualError,
		visualCardExpanded,
		handleVisualDraftSave,
		handleVisualAddToChat,
		handleVisualSendNow,
		handleVisualSaveComment,
		updateVisualComment,
		handleVisualAddToChatFromMark,
		handleVisualContinue,
		handleDeleteVisualTrace,
		handleOpenActiveVisualSession,
		handleStopVisualSession,
		deleteVisualTraceById,
		resetVisualCardChrome,
	};
}
