/**
 * Selection → 翻译 workflow for the EmbedPDF viewer: the one ephemeral mark kind.
 * A translate card is created straight from the selection menu and streams into
 * the open card. This cluster owns the whole run lifecycle
 * (`translateStreaming`, its cancel token, its error chrome) plus the record
 * write to `marks/<id>.json`.
 *
 * Its own hook for the record container and card chrome around one run: the
 * two providers behind the UI contract (an ACP Agent streamed through the
 * three agent listeners, cancellable; a plain translate provider, single
 * await) execute in the shared engine {@link runSelectionTranslate}, which
 * funnels back through `upsertTranslate` / `persistTranslate` /
 * `markTranslateFailure`, and nothing outside translate touches them.
 *
 * Boundaries:
 * - the persisted array lives in {@link usePdfMarksIo}: setters and the mirror
 *   ref are injected, never re-declared here;
 * - card placement / hover lives in {@link usePdfCards}: this hook only opens
 *   and hides its own card;
 * - `activeSessionRef` is shared with the ask cluster (at most one PDF agent run
 *   is in flight), so the parent owns it and injects it into both;
 * - the selection menu owns its own teardown, so the parent closes the menu and
 *   hands this hook the anchor.
 */

import type { UnlistenFn } from "@tauri-apps/api/event";
import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import type { PdfViewerProps } from "@/components/viewer/pdf/types";
import { cancelAgentRun, disposeAgentRun } from "@/lib/agent";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import type { PdfAskAnchor } from "@/lib/pdf/ask/types";
import type { ActiveSelectionCard } from "@/lib/pdf/selection";
import {
	createTranslateRecord,
	deletePdfTranslate,
	runSelectionTranslate,
	writePdfTranslate,
} from "@/lib/pdf/translate";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";

export type UsePdfSelectionTranslateOptions = {
	isActive: boolean;
	/** Sidecar root for `marks/<id>.json` (null for loose PDFs — nothing persists). */
	paperAbsPath: string | null;
	/** Vault-relative provenance stamped into the record. */
	paperRelPath: string | null;
	/** Vault root passed to the Agent run as its cwd. */
	vaultPath: string | null;
	/** Viewer prop: open Translate settings from the error card. */
	onOpenSettings: PdfViewerProps["onOpenSettings"];
	/** Persisted translate records; owned by {@link usePdfMarksIo}. */
	translatesRef: RefObject<PdfTranslateRecord[]>;
	protectedTranslateIdsRef: RefObject<Set<string>>;
	setTranslates: Dispatch<SetStateAction<PdfTranslateRecord[]>>;
	upsertTranslate: (
		rec: PdfTranslateRecord,
		options?: { preservePinned?: boolean },
	) => PdfTranslateRecord;
	/** Cards cluster; owned by {@link usePdfCards}. */
	openCard: (card: ActiveSelectionCard) => void;
	/**
	 * Single in-flight PDF agent run, shared with the ask cluster. Parent-owned so
	 * either cluster can cancel the other's session token.
	 */
	activeSessionRef: RefObject<string | null>;
};

export type PdfSelectionTranslate = {
	translateStreaming: boolean;
	translateError: string | null;
	/** Selection-menu action: create the record and start the run. */
	translateSelection: (anchor: PdfAskAnchor) => void;
	/** Toggle whether the result survives dismissal, without affecting the run. */
	toggleTranslatePin: (record: PdfTranslateRecord) => void;
	/** Discard an unpinned result when its card is dismissed. */
	discardUnpinnedTranslateOnClose: (id: string) => void;
	/** Cancel the in-flight run; also wired into {@link usePdfCards}. */
	stopTranslateSession: () => void;
	/** Error card action: open Translate settings. */
	openTranslateSettings: () => void;
	/** Per-kind chrome reset for card open / close (wired into `usePdfCards`). */
	clearTranslateError: () => void;
};

export function usePdfSelectionTranslate({
	isActive,
	paperAbsPath,
	paperRelPath,
	vaultPath,
	onOpenSettings,
	translatesRef,
	protectedTranslateIdsRef,
	setTranslates,
	upsertTranslate,
	openCard,
	activeSessionRef,
}: UsePdfSelectionTranslateOptions): PdfSelectionTranslate {
	const { t } = useTranslation("viewer");
	const tRef = useRef(t);
	tRef.current = t;
	const [translateStreaming, setTranslateStreaming] = useState(false);
	const [translateError, setTranslateError] = useState<string | null>(null);
	/** ACP session of the running translate turn (null for provider translate). */
	const translateSessionRef = useRef<string | null>(null);
	/** Per-run IPC unlisteners of the in-flight translate turn (null when idle). */
	const translateUnsubsRef = useRef<UnlistenFn[] | null>(null);
	/** True once the viewer unmounts; guards runs accepted after teardown. */
	const translateDisposedRef = useRef(false);
	/** Invalidates callbacks after a temporary result is dismissed or replaced. */
	const translateGenerationRef = useRef(0);
	/** The run id lets dismissal cancel only the result attached to that card. */
	const translateRunIdRef = useRef<string | null>(null);
	/** Unpinned results are temporary and are cleaned up if the viewer unmounts. */
	const temporaryTranslateIdsRef = useRef(new Set<string>());
	/** Serialize writes and removals so late pin toggles cannot win races. */
	const pendingWritesRef = useRef(new Map<string, Promise<void>>());

	const stopTranslateSession = useCallback(() => {
		translateGenerationRef.current += 1;
		translateRunIdRef.current = null;
		const sid = translateSessionRef.current;
		if (sid) {
			void cancelAgentRun(sid).catch(() => undefined);
			if (activeSessionRef.current === sid) activeSessionRef.current = null;
			translateSessionRef.current = null;
		}
		setTranslateStreaming(false);
	}, [activeSessionRef]);

	const clearTranslateError = useCallback(() => {
		setTranslateError(null);
	}, []);

	const openTranslateSettings = useCallback(() => {
		onOpenSettings?.();
	}, [onOpenSettings]);

	const persistTranslate = useCallback(
		(rec: PdfTranslateRecord): Promise<void> => {
			if (!paperAbsPath) return Promise.resolve();
			protectedTranslateIdsRef.current.add(rec.id);
			let saved = false;
			const previous = pendingWritesRef.current.get(rec.id);
			const save = (previous ?? Promise.resolve())
				.catch(() => undefined)
				.then(() => writePdfTranslate(paperAbsPath, rec))
				.then(() => {
					saved = true;
				})
				.catch((error) => {
					notifyError(tRef.current("selection.translateUpdateFailed"), {
						description: errorText(error),
					});
				});
			pendingWritesRef.current.set(rec.id, save);
			void save.then(() => {
				if (pendingWritesRef.current.get(rec.id) === save) {
					pendingWritesRef.current.delete(rec.id);
					if (saved && translateRunIdRef.current !== rec.id)
						protectedTranslateIdsRef.current.delete(rec.id);
				}
			});
			return save;
		},
		[paperAbsPath, protectedTranslateIdsRef],
	);

	const removePersistedTranslate = useCallback(
		(id: string): Promise<void> => {
			if (!paperAbsPath) return Promise.resolve();
			protectedTranslateIdsRef.current.add(id);
			let removed = false;
			const previous = pendingWritesRef.current.get(id);
			const remove = (previous ?? Promise.resolve())
				.catch(() => undefined)
				.then(() => deletePdfTranslate(paperAbsPath, id))
				.then(() => {
					removed = true;
				})
				.catch((error) => {
					notifyError(tRef.current("selection.translateUpdateFailed"), {
						description: errorText(error),
					});
				});
			pendingWritesRef.current.set(id, remove);
			void remove.then(() => {
				if (pendingWritesRef.current.get(id) === remove) {
					pendingWritesRef.current.delete(id);
					if (removed) protectedTranslateIdsRef.current.delete(id);
				}
			});
			return remove;
		},
		[paperAbsPath, protectedTranslateIdsRef],
	);

	// Closing the viewer must not strand the run's IPC listeners (or the run
	// itself). Unpinned results are temporary, so remove their sidecars on teardown.
	useEffect(() => {
		translateDisposedRef.current = false;
		return () => {
			translateGenerationRef.current += 1;
			disposeAgentRun({
				disposedRef: translateDisposedRef,
				unsubsRef: translateUnsubsRef,
				sessionRef: translateSessionRef,
				activeSessionRef,
			});
			const temporaryIds = [...temporaryTranslateIdsRef.current];
			temporaryTranslateIdsRef.current.clear();
			for (const id of temporaryIds) void removePersistedTranslate(id);
		};
	}, [activeSessionRef, removePersistedTranslate]);

	const toggleTranslatePin = useCallback(
		(record: PdfTranslateRecord) => {
			const current =
				translatesRef.current.find((item) => item.id === record.id) ?? record;
			const next = upsertTranslate(
				{
					...current,
					pinned: !current.pinned,
					updatedAt: new Date().toISOString(),
				},
				{ preservePinned: false },
			);
			if (next.pinned) temporaryTranslateIdsRef.current.delete(next.id);
			else temporaryTranslateIdsRef.current.add(next.id);
			void persistTranslate(next);
		},
		[translatesRef, upsertTranslate, persistTranslate],
	);

	const discardUnpinnedTranslateOnClose = useCallback(
		(id: string) => {
			const record = translatesRef.current.find((item) => item.id === id);
			if (record?.pinned) return;

			temporaryTranslateIdsRef.current.delete(id);
			if (translateRunIdRef.current === id) {
				stopTranslateSession();
			}

			const remaining = translatesRef.current.filter((item) => item.id !== id);
			translatesRef.current = remaining;
			setTranslates(remaining);
			void removePersistedTranslate(id);
		},
		[
			removePersistedTranslate,
			setTranslates,
			stopTranslateSession,
			translatesRef,
		],
	);

	const translateSelection = useCallback(
		(anchor: PdfAskAnchor) => {
			const quote = anchor.quote?.trim();
			if (!quote || !isActive) return;
			stopTranslateSession();
			const paperPath = paperRelPath || paperAbsPath || "paper";
			const paperKey = paperRelPath || paperAbsPath || null;
			const rec = createTranslateRecord({
				paperPath,
				page: anchor.page,
				rects: anchor.rects,
				selectionPages: anchor.selectionPages,
				quote,
			});
			let currentRecord = upsertTranslate(rec);
			protectedTranslateIdsRef.current.add(rec.id);
			temporaryTranslateIdsRef.current.add(rec.id);
			openCard({ kind: "translate", id: rec.id });
			const generation = translateGenerationRef.current;
			translateRunIdRef.current = rec.id;
			setTranslateStreaming(true);
			setTranslateError(null);
			const isCurrentRun = () =>
				translateGenerationRef.current === generation &&
				!translateDisposedRef.current;
			const commitResult = (result: string) => {
				if (!isCurrentRun()) return false;
				currentRecord = upsertTranslate({
					...currentRecord,
					result: result.trim(),
					updatedAt: new Date().toISOString(),
					error: undefined,
				});
				setTranslateStreaming(false);
				setTranslateError(null);
				if (translateRunIdRef.current === rec.id) {
					translateRunIdRef.current = null;
				}
				void persistTranslate(currentRecord);
				return true;
			};

			void runSelectionTranslate({
				text: quote,
				context: { page: anchor.page, surface: "pdf-selection" },
				paperKey,
				vaultPath,
				noAgentText: () => t("selection.translateNoAgent"),
				agentFailedText: () => t("pdfAsk.agentFailed"),
				disposedRef: {
					get current() {
						return !isCurrentRun();
					},
				},
				unsubsRef: translateUnsubsRef,
				sessionRef: translateSessionRef,
				activeSessionRef,
				appendChunk: (chunk) => {
					if (!isCurrentRun()) return;
					currentRecord = upsertTranslate({
						...currentRecord,
						result: (currentRecord.result ?? "") + chunk,
						updatedAt: new Date().toISOString(),
						error: undefined,
					});
				},
				commitAgentResult: (ev) =>
					commitResult(ev.content || currentRecord.result || ""),
				commitProviderResult: commitResult,
				markFailed: (message) => {
					if (!isCurrentRun()) return;
					currentRecord = upsertTranslate({
						...currentRecord,
						error: message,
						updatedAt: new Date().toISOString(),
					});
					setTranslateStreaming(false);
					setTranslateError(message);
					if (translateRunIdRef.current === rec.id) {
						translateRunIdRef.current = null;
					}
				},
				stopStreaming: () => {
					if (isCurrentRun()) setTranslateStreaming(false);
				},
			});
		},
		[
			t,
			isActive,
			vaultPath,
			paperAbsPath,
			paperRelPath,
			stopTranslateSession,
			upsertTranslate,
			protectedTranslateIdsRef,
			persistTranslate,
			openCard,
			activeSessionRef,
		],
	);

	return {
		translateStreaming,
		translateError,
		translateSelection,
		toggleTranslatePin,
		discardUnpinnedTranslateOnClose,
		stopTranslateSession,
		openTranslateSettings,
		clearTranslateError,
	};
}
