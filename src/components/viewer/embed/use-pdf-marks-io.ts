/**
 * Persisted mark arrays for the EmbedPDF viewer — ask threads, translate records
 * and visual agent-trace marks — plus the disk↔state synchronisation that keeps
 * them fresh while an Agent writes the same `marks/` folder from outside.
 *
 * One hook because all three arrays share a single IO lifecycle: one `list*`
 * fan-out on open, one Vault-watcher subscription, and one publish path to the
 * annotations panel. Listing re-reads every mark file over serial IPC, so the
 * refresh must stay event-driven (never a timer), is coalesced over a 200 ms
 * burst (one Agent turn rewrites several files), and is fingerprint-guarded:
 * `list*` always returns fresh array identity, and committing an unchanged array
 * re-renders the whole viewer, which makes the pages visibly twitch.
 *
 * Only pure state updaters live here. Anything that writes a mark to disk as
 * part of an ask / translate / visual workflow stays with that workflow, so the
 * setters and mirror refs are returned for those clusters to use.
 */

import {
	type Dispatch,
	type RefObject,
	type SetStateAction,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import type { PdfViewerProps } from "@/components/viewer/embed/pdf-viewer-types";
import { isTauri } from "@/lib/core/tauri";
import {
	listPdfVisualTraces,
	type PdfVisualSessionTrace,
} from "@/lib/pdf/agent-trace";
import { listPdfAskThreads } from "@/lib/pdf/ask";
import { threadHasUserQuestion } from "@/lib/pdf/ask/schema";
import type { PdfAskThread } from "@/lib/pdf/ask/types";
import { marksDir } from "@/lib/pdf/selection";
import { listPdfTranslates } from "@/lib/pdf/translate";
import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";
import {
	VAULT_FILE_CHANGED_EVENT,
	type VaultFileChangedPayload,
} from "@/lib/vault/fs-watch";
import { normalizePathKey } from "@/lib/vault/path";

/** One Agent turn can rewrite several mark files; coalesce the burst. */
const MARKS_REFRESH_BURST_MS = 200;

export type UsePdfMarksIoOptions = {
	/** Sidecar root for `marks/` (null for loose PDFs — nothing is persisted). */
	paperAbsPath: string | null;
	/**
	 * Workspace active tab. Dock may keep inactive PDFs mounted; only the active
	 * viewer refreshes marks/ (expensive base64 JSON list).
	 */
	isActive: boolean;
	/** Prop-latest refs so publishing never re-fires on parent re-render. */
	onAsksChangeRef: RefObject<PdfViewerProps["onAsksChange"]>;
	onVisualTracesChangeRef: RefObject<PdfViewerProps["onVisualTracesChange"]>;
};

export type PdfMarksIo = {
	threads: PdfAskThread[];
	threadsRef: RefObject<PdfAskThread[]>;
	setThreads: Dispatch<SetStateAction<PdfAskThread[]>>;
	translates: PdfTranslateRecord[];
	translatesRef: RefObject<PdfTranslateRecord[]>;
	setTranslates: Dispatch<SetStateAction<PdfTranslateRecord[]>>;
	visualTraces: PdfVisualSessionTrace[];
	visualTracesRef: RefObject<PdfVisualSessionTrace[]>;
	setVisualTraces: Dispatch<SetStateAction<PdfVisualSessionTrace[]>>;
	/** Replace-or-prepend by id (newest first); no disk write. */
	upsertThread: (thread: PdfAskThread) => void;
	upsertTranslate: (rec: PdfTranslateRecord) => void;
	upsertVisualTrace: (trace: PdfVisualSessionTrace) => void;
};

export function usePdfMarksIo({
	paperAbsPath,
	isActive,
	onAsksChangeRef,
	onVisualTracesChangeRef,
}: UsePdfMarksIoOptions): PdfMarksIo {
	const [threads, setThreads] = useState<PdfAskThread[]>([]);
	const [translates, setTranslates] = useState<PdfTranslateRecord[]>([]);
	const [visualTraces, setVisualTraces] = useState<PdfVisualSessionTrace[]>([]);
	const threadsRef = useRef(threads);
	threadsRef.current = threads;
	const translatesRef = useRef(translates);
	translatesRef.current = translates;
	const visualTracesRef = useRef(visualTraces);
	visualTracesRef.current = visualTraces;
	const marksLoadedRef = useRef(false);

	const upsertThread = useCallback((thread: PdfAskThread) => {
		setThreads((prev) => {
			const i = prev.findIndex((t) => t.id === thread.id);
			if (i < 0) return [thread, ...prev];
			const next = [...prev];
			next[i] = thread;
			return next;
		});
	}, []);

	const upsertTranslate = useCallback((rec: PdfTranslateRecord) => {
		setTranslates((prev) => {
			const i = prev.findIndex((x) => x.id === rec.id);
			if (i < 0) return [rec, ...prev];
			const next = [...prev];
			next[i] = rec;
			return next;
		});
	}, []);

	const upsertVisualTrace = useCallback((trace: PdfVisualSessionTrace) => {
		setVisualTraces((prev) => {
			const next = [trace, ...prev.filter((tr) => tr.id !== trace.id)];
			// Keep ref in sync so openCard/placeActiveCard can find a just-created mark.
			visualTracesRef.current = next;
			return next;
		});
	}, []);

	// Load persisted ask threads + translate records + agent-trace marks once.
	useEffect(() => {
		if (marksLoadedRef.current || !paperAbsPath) return;
		marksLoadedRef.current = true;
		void (async () => {
			const [ts, trs, traces] = await Promise.all([
				listPdfAskThreads(paperAbsPath),
				listPdfTranslates(paperAbsPath),
				listPdfVisualTraces(paperAbsPath),
			]);
			if (ts.length) setThreads(ts);
			if (trs.length) setTranslates(trs);
			if (traces.length) setVisualTraces(traces);
		})();
	}, [paperAbsPath]);

	// Refresh ask conversation cards + agent-trace pins when this viewer is
	// active (dock may keep inactive PDFs mounted under pdfKeepMounted —
	// avoid N× listMarkRaw reads). Covers Agent-panel writes that create ask
	// threads from 「加入对话」 selections while this tab was open.
	//
	// Driven by the Vault watcher: listing re-reads every mark file over serial
	// IPC, so it must not run on a timer. Results always carry fresh array
	// identity; only commit state when the content actually changed — otherwise
	// a refresh re-renders the whole viewer and the pages visibly twitch.
	const lastMarksPollRef = useRef("{asks:[],traces:[]}");
	useEffect(() => {
		if (!paperAbsPath || !marksLoadedRef.current || !isActive) return;
		let cancelled = false;
		const refresh = () => {
			void Promise.all([
				listPdfAskThreads(paperAbsPath),
				listPdfVisualTraces(paperAbsPath),
			]).then(([asks, traces]) => {
				if (cancelled) return;
				let fingerprint: string;
				try {
					fingerprint = JSON.stringify({ asks, traces });
				} catch {
					fingerprint = "";
				}
				if (fingerprint && fingerprint === lastMarksPollRef.current) {
					return;
				}
				lastMarksPollRef.current = fingerprint;
				setThreads(asks);
				setVisualTraces(traces);
			});
		};
		// Immediate refresh on become-active (covers Agent multi-turn writes
		// while this tab was backgrounded).
		refresh();
		const onFocus = () => refresh();
		window.addEventListener("focus", onFocus);

		// One Agent turn can rewrite several mark files; coalesce the burst.
		let burstTimer: number | null = null;
		const scheduleRefresh = () => {
			if (burstTimer !== null) return;
			burstTimer = window.setTimeout(() => {
				burstTimer = null;
				refresh();
			}, MARKS_REFRESH_BURST_MS);
		};
		const marksKey = `${normalizePathKey(marksDir(paperAbsPath))}/`;
		let unsubMarks: (() => void) | undefined;
		if (isTauri()) {
			void (async () => {
				const { listen } = await import("@tauri-apps/api/event");
				if (cancelled) return;
				unsubMarks = await listen<VaultFileChangedPayload>(
					VAULT_FILE_CHANGED_EVENT,
					({ payload }) => {
						const paths = [...payload.paths];
						if (payload.rename) {
							paths.push(payload.rename.from, payload.rename.to);
						}
						const hit = paths.some((p) =>
							normalizePathKey(p).startsWith(marksKey),
						);
						if (hit) scheduleRefresh();
					},
				);
			})();
		}
		return () => {
			cancelled = true;
			window.removeEventListener("focus", onFocus);
			if (burstTimer !== null) window.clearTimeout(burstTimer);
			unsubMarks?.();
		};
	}, [paperAbsPath, isActive]);

	// Publish ask threads (with a real question) to the annotations panel.
	useEffect(() => {
		onAsksChangeRef.current?.(threads.filter(threadHasUserQuestion));
	}, [threads, onAsksChangeRef]);

	// Publish visual agent-trace marks to the annotations panel.
	useEffect(() => {
		onVisualTracesChangeRef.current?.(visualTraces);
	}, [visualTraces, onVisualTracesChangeRef]);

	return {
		threads,
		threadsRef,
		setThreads,
		translates,
		translatesRef,
		setTranslates,
		visualTraces,
		visualTracesRef,
		setVisualTraces,
		upsertThread,
		upsertTranslate,
		upsertVisualTrace,
	};
}
