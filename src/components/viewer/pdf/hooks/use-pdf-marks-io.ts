/**
 * Persisted mark arrays for the EmbedPDF viewer — ask threads, translate records
 * and visual agent-trace marks — plus the disk↔state synchronisation that keeps
 * them fresh while an Agent writes the same `marks/` folder from outside.
 *
 * One hook because all three arrays share a single IO lifecycle: one `list*`
 * fan-out on open, one Vault-watcher subscription, and one publish path to the
 * annotations panel. Listing re-reads every mark file over IPC, so the
 * refresh must stay event-driven (never a timer), is coalesced over a 200 ms
 * burst (one Agent turn rewrites several files), skips echoes of this app's
 * own marks/ writes, and is fingerprint-guarded: `list*` always returns fresh
 * array identity, and committing an unchanged array re-renders the whole
 * viewer, which makes the pages visibly twitch.
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
import { useStableDerived } from "@/components/viewer/pdf/hooks/use-stable-derived";
import type { PdfViewerProps } from "@/components/viewer/pdf/types";
import {
	listPdfVisualTraces,
	type PdfVisualSessionTrace,
} from "@/lib/pdf/agent-trace";
import { listPdfAskThreads } from "@/lib/pdf/ask";
import { threadHasUserQuestion, threadPreview } from "@/lib/pdf/ask/schema";
import type { PdfAskThread } from "@/lib/pdf/ask/types";
import { marksDir } from "@/lib/pdf/selection";
import {
	isRecentSelfWrite,
	subscribeLocalMarkWrites,
} from "@/lib/pdf/selection/marks-io";
import { listPdfTranslates } from "@/lib/pdf/translate";

/**
 * Disk refresh replaces the trace list. A click-crop is held in memory until
 * the user commits a note, so a refresh must not drop that unsaved draft.
 */
export function keepUnsavedVisualDrafts(
	prev: PdfVisualSessionTrace[],
	incoming: PdfVisualSessionTrace[],
): PdfVisualSessionTrace[] {
	if (prev.length === 0) return incoming;
	const incomingIds = new Set(incoming.map((trace) => trace.id));
	const pending = prev.filter(
		(trace) =>
			!incomingIds.has(trace.id) &&
			Boolean(trace.image?.data) &&
			!trace.image?.path,
	);
	return pending.length === 0 ? incoming : [...pending, ...incoming];
}

import type { PdfTranslateRecord } from "@/lib/pdf/translate/types";
import { listenVaultFileChangedGated } from "@/lib/vault/file-change-gate";
import { normalizePathKey } from "@/lib/vault/path";

/** One Agent turn can rewrite several mark files; coalesce the burst. */
const MARKS_REFRESH_BURST_MS = 200;

/** Unsubmitted conversations only exist in memory. */
function mergeAskRefresh(
	current: PdfAskThread[],
	incoming: PdfAskThread[],
): PdfAskThread[] {
	const incomingIds = new Set(incoming.map((thread) => thread.id));
	const drafts = current.filter(
		(thread) => !threadHasUserQuestion(thread) && !incomingIds.has(thread.id),
	);
	return [...drafts, ...incoming];
}

/** Preserve live results and pending deletions while accepting other disk edits. */
export function mergeTranslateRefresh(
	current: PdfTranslateRecord[],
	incoming: PdfTranslateRecord[],
	protectedIds: ReadonlySet<string>,
	recordsAtStart: PdfTranslateRecord[] = current,
): PdfTranslateRecord[] {
	const protectedNow = new Set(protectedIds);
	const before = new Map(recordsAtStart.map((record) => [record.id, record]));
	const after = new Map(current.map((record) => [record.id, record]));
	for (const id of new Set([...before.keys(), ...after.keys()])) {
		if (before.get(id) !== after.get(id)) protectedNow.add(id);
	}
	return [
		...current.filter((record) => protectedNow.has(record.id)),
		...incoming.filter((record) => !protectedNow.has(record.id)),
	];
}

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
	/** Local runs and pending writes take precedence over disk refreshes. */
	protectedTranslateIdsRef: RefObject<Set<string>>;
	setTranslates: Dispatch<SetStateAction<PdfTranslateRecord[]>>;
	visualTraces: PdfVisualSessionTrace[];
	visualTracesRef: RefObject<PdfVisualSessionTrace[]>;
	setVisualTraces: Dispatch<SetStateAction<PdfVisualSessionTrace[]>>;
	/** Replace-or-prepend by id (newest first); no disk write. */
	upsertThread: (thread: PdfAskThread) => void;
	upsertTranslate: (
		rec: PdfTranslateRecord,
		options?: { preservePinned?: boolean },
	) => PdfTranslateRecord;
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
	const protectedTranslateIdsRef = useRef(new Set<string>());
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

	const upsertTranslate = useCallback(
		(
			rec: PdfTranslateRecord,
			{ preservePinned = true }: { preservePinned?: boolean } = {},
		): PdfTranslateRecord => {
			const prev = translatesRef.current;
			const i = prev.findIndex((x) => x.id === rec.id);
			const existing = i >= 0 ? prev[i] : null;
			const nextRecord = {
				...rec,
				pinned: preservePinned ? (existing?.pinned ?? rec.pinned) : rec.pinned,
			};
			const next =
				i < 0
					? [nextRecord, ...prev]
					: prev.map((item, index) => (index === i ? nextRecord : item));
			translatesRef.current = next;
			setTranslates(next);
			return nextRecord;
		},
		[],
	);

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
		const protectedAtStart = new Set(protectedTranslateIdsRef.current);
		const recordsAtStart = translatesRef.current;
		void (async () => {
			const [ts, trs, traces] = await Promise.all([
				listPdfAskThreads(paperAbsPath),
				listPdfTranslates(paperAbsPath),
				listPdfVisualTraces(paperAbsPath),
			]);
			if (ts.length) setThreads((prev) => mergeAskRefresh(prev, ts));
			setTranslates((prev) =>
				mergeTranslateRefresh(
					prev,
					trs,
					new Set([...protectedAtStart, ...protectedTranslateIdsRef.current]),
					recordsAtStart,
				),
			);
			if (traces.length) {
				setVisualTraces((prev) => keepUnsavedVisualDrafts(prev, traces));
			}
		})();
	}, [paperAbsPath]);

	// Refresh ask conversation cards + agent-trace pins when this viewer is
	// active (dock may keep inactive PDFs mounted under keepMounted —
	// avoid N× listMarkRaw reads). Covers Agent-panel writes that create ask
	// threads from 「加入对话」 selections while this tab was open.
	//
	// Driven by the Vault watcher: listing re-reads every mark file over IPC,
	// so it must not run on a timer, and watcher echoes of this app's own
	// marks/ writes are skipped (the writer already updated state). Results
	// always carry fresh array identity; only commit state when the content
	// actually changed — otherwise a refresh re-renders the whole viewer and
	// the pages visibly twitch.
	const lastMarksPollRef = useRef("{asks:[],traces:[],translates:[]}");
	useEffect(() => {
		if (!paperAbsPath || !marksLoadedRef.current || !isActive) return;
		let cancelled = false;
		const refresh = () => {
			const protectedAtStart = new Set(protectedTranslateIdsRef.current);
			const recordsAtStart = translatesRef.current;
			void Promise.all([
				listPdfAskThreads(paperAbsPath),
				listPdfVisualTraces(paperAbsPath),
				listPdfTranslates(paperAbsPath),
			]).then(([asks, traces, translates]) => {
				if (cancelled) return;
				let fingerprint: string;
				try {
					fingerprint = JSON.stringify({ asks, traces, translates });
				} catch {
					fingerprint = "";
				}
				if (fingerprint && fingerprint === lastMarksPollRef.current) {
					return;
				}
				lastMarksPollRef.current = fingerprint;
				setThreads((prev) => mergeAskRefresh(prev, asks));
				setVisualTraces((prev) => keepUnsavedVisualDrafts(prev, traces));
				setTranslates((prev) => {
					const protectedIds = new Set([
						...protectedAtStart,
						...protectedTranslateIdsRef.current,
					]);
					return mergeTranslateRefresh(
						prev,
						translates,
						protectedIds,
						recordsAtStart,
					);
				});
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
		const unsubLocal = subscribeLocalMarkWrites((path) => {
			if (normalizePathKey(path).startsWith(marksKey)) scheduleRefresh();
		});
		const unsubMarks = listenVaultFileChangedGated((payload) => {
			const paths = [...payload.paths];
			if (payload.rename) {
				paths.push(payload.rename.from, payload.rename.to);
			}
			const marksPaths = paths.filter((p) =>
				normalizePathKey(p).startsWith(marksKey),
			);
			if (!marksPaths.length) return;
			// Our own writes already updated in-memory state; skip their
			// watcher echo unless an external change landed in the same batch.
			if (marksPaths.every((p) => isRecentSelfWrite(p))) return;
			scheduleRefresh();
		});
		return () => {
			cancelled = true;
			window.removeEventListener("focus", onFocus);
			if (burstTimer !== null) window.clearTimeout(burstTimer);
			unsubMarks();
			unsubLocal();
		};
	}, [paperAbsPath, isActive]);

	// Publish ask threads (with a real question) to the annotations panel.
	// Gated on a fingerprint of the fields the panel renders (question preview,
	// page, status, message count): streaming gives `threads` a fresh identity on
	// every chunk, and republishing each chunk rewrote annotationsStore and
	// re-rendered the panel several times per second.
	const asksFingerprint = threads
		.filter(threadHasUserQuestion)
		.map(
			(th) =>
				`${th.id}|${th.status}|${th.anchor.page}|${th.anchor.rects[0]?.y ?? 0}|${th.messages.length}|${threadPreview(th)}`,
		)
		.join(";");
	const publishedAsks = useStableDerived(
		() => threads.filter(threadHasUserQuestion),
		asksFingerprint,
	);
	useEffect(() => {
		onAsksChangeRef.current?.(publishedAsks);
	}, [publishedAsks, onAsksChangeRef]);

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
		protectedTranslateIdsRef,
		setTranslates,
		visualTraces,
		visualTracesRef,
		setVisualTraces,
		upsertThread,
		upsertTranslate,
		upsertVisualTrace,
	};
}
