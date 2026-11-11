/**
 * Highlights (划词高亮/批注) for the EmbedPDF viewer. Highlights are *not* an
 * app-side overlay: they are real PDF annotations owned by EmbedPDF's annotation
 * plugin and persisted to `marks/annotations.json`, so this cluster is the whole
 * bridge between that plugin scope and the React tree.
 *
 * It owns three derived states that share exactly one writer — `rebuildHighlights`,
 * which runs once per coalesced annotation-event burst (a batch import emits
 * one event per annotation):
 * - `highlights`: the view models published to the annotations panel;
 * - `highlightAnchors`: normalized 0–1 rects for gutter-pin placement, computed
 *   here (where the raw objects and page sizes are already in hand) so pin
 *   geometry never reads plugin state during render;
 * - `citationLinks`: the per-page link map, a by-product of the same walk over
 *   the tracked annotation list (consumed by {@link usePdfCitations}).
 *
 * Its own hook because plugin ownership is the boundary: import/migrate-on-open,
 * the event subscription and the debounced export are one lifecycle, while every
 * reader (page layers, pins, annotations panel, imperative handle) only needs the
 * resulting arrays.
 */

import { useCapability } from "@embedpdf/core/react";
import type {
	PdfHighlightAnnoObject,
	PdfLinkAnnoObject,
} from "@embedpdf/models";
import { PdfAnnotationSubtype } from "@embedpdf/models";
import type {
	AnnotationEvent,
	AnnotationTransferItem,
	useAnnotationCapability,
} from "@embedpdf/plugin-annotation/react";
import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import type { FormattedSelection } from "@embedpdf/plugin-selection/react";
import {
	type RefObject,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { isLinkObject } from "@/components/viewer/pdf/layers/citation-links";
import type { PdfViewerProps } from "@/components/viewer/pdf/types";
import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { planAnnotationItemImport } from "@/lib/pdf/highlight/annotation-items";
import {
	ANNOTATIONS_FILE,
	type HighlightCustom,
	hasAnnotationsFile,
	highlightViewFromObject,
	isHighlightObject,
	isLiveAnnotation,
	loadAnnotationItems,
	saveAnnotationItems,
} from "@/lib/pdf/highlight/annotation-store";
import {
	applyAnnotationMutation,
	enqueueAnnotationSave,
	publishAnnotationMutation,
	subscribeAnnotationPeer,
} from "@/lib/pdf/highlight/annotation-sync";
import { createAnnotationDeleteQueue } from "@/lib/pdf/highlight/delete-queue";
import {
	createAnnotationHistoryReplay,
	type PdfHistoryPlugin,
} from "@/lib/pdf/highlight/history";
import { migrateHighlightMarks } from "@/lib/pdf/highlight/migrate-marks";
import {
	HIGHLIGHT_HEX,
	HIGHLIGHT_OPACITY,
	type HighlightColor,
} from "@/lib/pdf/highlight/palette";
import type { PdfHighlight } from "@/lib/pdf/highlight/types";
import type { VisibleSelectionPage } from "@/lib/pdf/layout/visible-selection-rects";
import type { NormalizedRect } from "@/lib/pdf/selection";
import { marksDir } from "@/lib/pdf/selection";
import { isRecentSelfWrite } from "@/lib/pdf/selection/marks-io";
import { listenVaultFileChangedGated } from "@/lib/vault/file-change-gate";
import { joinVaultPath, normalizePathKey } from "@/lib/vault/path";

/** Coalesce annotation bursts (drag-create, multi-page highlight) into one export. */
const HIGHLIGHT_SAVE_DEBOUNCE_MS = 600;

/** One CLI invocation can append several highlights; coalesce the watcher burst. */
const ANNOTATIONS_REIMPORT_BURST_MS = 200;

type AnnotationCapabilityProvides = ReturnType<
	typeof useAnnotationCapability
>["provides"];

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

export type UsePdfHighlightsOptions = {
	/** EmbedPDF capability; owned by `PdfViewerInner` (plugin context). */
	annotationCap: AnnotationCapabilityProvides;
	/** EmbedPDF capability; returns a fresh scope each render, so never a dep. */
	docCap: DocumentManagerCapability;
	docId: string;
	/** Sidecar location for `marks/annotations.json` (null for loose PDFs). */
	paperAbsPath: string | null;
	/** Stable paper key stamped onto the published highlight view models. */
	paperKey: string | null;
	/** Import waits for the document, which is what makes the page count > 0. */
	totalPages: number;
	/** Prop-latest ref so publishing never re-fires on parent re-render. */
	onHighlightsChangeRef: RefObject<PdfViewerProps["onHighlightsChange"]>;
};

export type PdfHighlights = {
	runAnnotationBatch: (action: () => void) => void;
	replayAnnotationHistory: (redo: boolean) => void;
	highlights: PdfHighlight[];
	/** Mirror for the imperative handle (must not re-register per change). */
	highlightsRef: RefObject<PdfHighlight[]>;
	/** Annotation id → normalized rect, for gutter-pin placement. */
	highlightAnchors: Map<string, NormalizedRect>;
	/** 0-based page index → in-text link annotations with a target. */
	citationLinks: Map<number, PdfLinkAnnoObject[]>;
	/** Re-read the plugin scope; also the annotation-event handler. */
	rebuildHighlights: () => void;
	/** Create one highlight per selected page span; returns the new ids. */
	createHighlights: (
		pages: FormattedSelection[],
		color: HighlightColor,
		quote: string,
		/**
		 * Translated selection, in page fractions. Stored beside the English
		 * glyph boxes and painted only while the translation overlay is on.
		 */
		translatedPages?: readonly VisibleSelectionPage[],
	) => { pageIndex: number; id: string }[];
	/** Write a 批注 comment onto an existing highlight (empty clears it). */
	updateHighlightComment: (
		pageIndex: number,
		id: string,
		comment: string,
	) => void;
	/** Change the color of an existing highlight annotation. */
	updateHighlightColor: (
		pageIndex: number,
		id: string,
		color: HighlightColor,
	) => void;
	deleteHighlightAnnotation: (pageIndex: number, id: string) => void;
};

export function usePdfHighlights({
	annotationCap,
	docCap,
	docId,
	paperAbsPath,
	paperKey,
	totalPages,
	onHighlightsChangeRef,
}: UsePdfHighlightsOptions): PdfHighlights {
	const { provides: historyCap } = useCapability<PdfHistoryPlugin>("history");
	const history = historyCap?.forDocument(docId);
	const historyReplayRef = useRef<ReturnType<
		typeof createAnnotationHistoryReplay
	> | null>(null);
	const runAnnotationBatch = useCallback(
		(action: () => void) => {
			if (history) history.batch(action);
			else action();
		},
		[history],
	);
	const replayAnnotationHistory = useCallback((redo: boolean) => {
		void historyReplayRef.current?.replay(redo);
	}, []);
	const [highlights, setHighlights] = useState<PdfHighlight[]>([]);
	/** Normalized annotation rects for pin placement, keyed by annotation id. */
	const [highlightAnchors, setHighlightAnchors] = useState(
		() => new Map<string, NormalizedRect>(),
	);
	const [citationLinks, setCitationLinks] = useState<
		Map<number, PdfLinkAnnoObject[]>
	>(new Map());
	const highlightsRef = useRef(highlights);
	highlightsRef.current = highlights;
	const importedRef = useRef(false);
	const importingRef = useRef(false);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const deleteQueueRef = useRef<ReturnType<
		typeof createAnnotationDeleteQueue
	> | null>(null);
	const initialImportDoneRef = useRef(false);
	const pendingPeerEventsRef = useRef<
		Exclude<AnnotationEvent, { type: "loaded" }>[]
	>([]);
	const applyPeerEvent = useCallback(
		(event: Exclude<AnnotationEvent, { type: "loaded" }>) => {
			if (!initialImportDoneRef.current) {
				pendingPeerEventsRef.current.push(event);
				return;
			}
			const scope = annotationCap?.forDocument(docId);
			if (!scope) return;
			const wasImporting = importingRef.current;
			importingRef.current = true;
			try {
				history?.invalidate([event.annotation.id]);
				const apply = () => {
					if (event.type === "delete" && deleteQueueRef.current) {
						const tracked = scope.getAnnotationById(event.annotation.id);
						if (tracked && isLiveAnnotation(tracked))
							deleteQueueRef.current.delete(
								event.pageIndex,
								event.annotation.id,
							);
					} else applyAnnotationMutation(scope, event);
				};
				if (history) history.withoutRecording(apply);
				else apply();
				scope.commit();
			} catch (error) {
				notifyError(errorText(error));
			} finally {
				importingRef.current = wasImporting;
			}
		},
		[annotationCap, docId, history],
	);
	useEffect(() => {
		if (!paperAbsPath || !annotationCap) return;
		return subscribeAnnotationPeer(paperAbsPath, docId, applyPeerEvent);
	}, [paperAbsPath, docId, annotationCap, applyPeerEvent]);

	const rebuildHighlights = useCallback(() => {
		if (!annotationCap) return;
		const scope = annotationCap.forDocument(docId);
		// Deleted annotations stay in the plugin's tracked list until an async
		// commit purges them (and a dropped commit can leave them there for the
		// session). They must not reach the rail, pins or paint layers.
		const all = scope.getAnnotations().filter(isLiveAnnotation);
		const doc = docCap?.getDocument(docId);
		const objects = all.map((a) => a.object).filter(isHighlightObject);
		const list = objects.map((o) => {
			const view = highlightViewFromObject(o, paperKey ?? "");
			const size = doc?.pages[o.pageIndex]?.size;
			if (size?.width && size?.height) {
				const pw = size.width;
				const ph = size.height;
				const sourceRects = o.segmentRects?.length ? o.segmentRects : [o.rect];
				view.rects = sourceRects.map((r) => ({
					x: r.origin.x / pw,
					y: r.origin.y / ph,
					w: r.size.width / pw,
					h: r.size.height / ph,
				}));
			}
			return view;
		});
		setHighlights(list);
		onHighlightsChangeRef.current?.(list);
		// Pin anchors: normalize each annotation rect here, where the objects are
		// already in hand, so pin geometry never reads plugin state during render.
		const anchors = new Map<string, NormalizedRect>();
		for (const o of objects) {
			const size = doc?.pages[o.pageIndex]?.size;
			if (!size?.width || !size?.height) continue;
			anchors.set(o.id, {
				x: o.rect.origin.x / size.width,
				y: o.rect.origin.y / size.height,
				w: o.rect.size.width / size.width,
				h: o.rect.size.height / size.height,
			});
		}
		setHighlightAnchors(anchors);
		const links = new Map<number, PdfLinkAnnoObject[]>();
		for (const tracked of all) {
			const o = tracked.object;
			if (isLinkObject(o) && o.target) {
				const arr = links.get(o.pageIndex);
				if (arr) arr.push(o);
				else links.set(o.pageIndex, [o]);
			}
		}
		// The link set only changes when a link annotation is added / removed /
		// retargeted — saving a comment or recoloring a highlight leaves it
		// identical. Keep the previous map reference then, so the pages' link
		// layers don't re-render (elements are the plugin's tracked annotation
		// objects, so identity per element is the equality that matters).
		setCitationLinks((prev) => {
			if (prev.size === links.size) {
				let unchanged = true;
				for (const [page, next] of links) {
					const old = prev.get(page);
					if (
						!old ||
						old.length !== next.length ||
						next.some((link, i) => link !== old[i])
					) {
						unchanged = false;
						break;
					}
				}
				if (unchanged) return prev;
			}
			return links;
		});
	}, [annotationCap, docCap, docId, paperKey, onHighlightsChangeRef]);

	const persistAnnotations = useCallback(() => {
		if (!paperAbsPath || !annotationCap) return;
		// Capture while this document still exists, including an unmount flush.
		const snapshot = annotationCap
			.forDocument(docId)
			.exportAnnotations()
			.toPromise();
		void enqueueAnnotationSave(paperAbsPath, async () => {
			await saveAnnotationItems(paperAbsPath, await snapshot);
		}).catch((error) => notifyError(errorText(error)));
	}, [paperAbsPath, annotationCap, docId]);

	/** Deletions bypass the normal debounce. */
	const scheduleSave = useCallback(
		(immediate = false) => {
			if (!paperAbsPath || !annotationCap) return;
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			saveTimerRef.current = setTimeout(
				() => {
					saveTimerRef.current = null;
					persistAnnotations();
				},
				immediate ? 0 : HIGHLIGHT_SAVE_DEBOUNCE_MS,
			);
		},
		[paperAbsPath, annotationCap, persistAnnotations],
	);
	useLayoutEffect(
		() => () => {
			if (!saveTimerRef.current) return;
			clearTimeout(saveTimerRef.current);
			saveTimerRef.current = null;
			persistAnnotations();
		},
		[persistAnnotations],
	);

	useEffect(() => {
		if (!annotationCap) return;
		let cancelled = false;
		let pending = false;
		const scope = annotationCap.forDocument(docId);
		const off = scope.onAnnotationEvent((event) => {
			// Coalesce import bursts, but never read a scope after its subscription
			// has gone away: the parent can already have destroyed the plugin.
			if (!pending) {
				pending = true;
				queueMicrotask(() => {
					pending = false;
					if (!cancelled) rebuildHighlights();
				});
			}
			if (
				event.type !== "loaded" &&
				!event.committed &&
				!importingRef.current
			) {
				if (paperAbsPath) publishAnnotationMutation(paperAbsPath, event);
				scheduleSave(event.type === "delete");
			}
		});
		rebuildHighlights();
		return () => {
			cancelled = true;
			off();
		};
	}, [annotationCap, docId, paperAbsPath, rebuildHighlights, scheduleSave]);

	useEffect(() => {
		if (importedRef.current || !annotationCap || !docCap || totalPages <= 0)
			return;
		importedRef.current = true;
		let cancelled = false;
		let finished = false;
		let started = false;
		let settleTimer: ReturnType<typeof setTimeout> | null = null;
		const scope = annotationCap.forDocument(docId);
		const importSavedAnnotations = async () => {
			let items: AnnotationTransferItem[] = paperAbsPath
				? await loadAnnotationItems(paperAbsPath)
				: [];
			if (cancelled) return;
			if (
				paperAbsPath &&
				!items.length &&
				!(await hasAnnotationsFile(paperAbsPath))
			) {
				if (cancelled) return;
				const doc = docCap.getDocument(docId);
				const migrated = await migrateHighlightMarks(
					paperAbsPath,
					(pageIndex) => doc?.pages[pageIndex]?.size ?? null,
				);
				if (cancelled) return;
				if (migrated.length) {
					items = migrated;
					await saveAnnotationItems(paperAbsPath, migrated);
				}
			}
			if (cancelled) return;
			if (items.length) {
				importingRef.current = true;
				const plan = planAnnotationItemImport(
					items,
					scope
						.getAnnotations()
						.filter(isLiveAnnotation)
						.map((item) => item.object),
				);
				if (plan.imports.length) scope.importAnnotations(plan.imports);
				if (plan.highlightOverrides.length) {
					const apply = () => scope.updateAnnotations(plan.highlightOverrides);
					if (history) history.withoutRecording(apply);
					else apply();
					scope.commit();
				}
			}
			settleTimer = setTimeout(() => {
				settleTimer = null;
				if (cancelled) return;
				finished = true;
				importingRef.current = false;
				initialImportDoneRef.current = true;
				for (const event of pendingPeerEventsRef.current.splice(0))
					applyPeerEvent(event);
				rebuildHighlights();
			}, 0);
		};
		const startImport = () => {
			if (cancelled || started) return;
			started = true;
			void importSavedAnnotations().catch((error) => {
				if (cancelled) return;
				importedRef.current = false;
				importingRef.current = false;
				notifyError(errorText(error));
			});
		};
		// The plugin queues imports until native annotation loading completes.
		// Planning against its still-empty store would enqueue every saved link
		// and duplicate them when that queue is replayed. Subscribe before reading
		// state; loaded pages include empty arrays even on unannotated pages.
		const offLoaded = scope.onAnnotationEvent((event) => {
			if (event.type === "loaded") startImport();
		});
		if (Object.keys(scope.getState().pages).length >= totalPages) startImport();
		return () => {
			cancelled = true;
			offLoaded();
			if (settleTimer !== null) clearTimeout(settleTimer);
			if (!finished) {
				importedRef.current = false;
				importingRef.current = false;
			}
		};
	}, [
		annotationCap,
		docCap,
		docId,
		totalPages,
		paperAbsPath,
		rebuildHighlights,
		applyPeerEvent,
		history,
	]);

	// The CLI/Agent appends highlights straight into `marks/annotations.json`
	// (`agentero mark add --kind highlight`). The import above runs once per
	// mount, so without this an open viewer would neither show those highlights
	// nor keep them: its next debounced export would overwrite the file.
	useEffect(() => {
		if (!paperAbsPath || !annotationCap || totalPages <= 0) return;
		const target = normalizePathKey(
			joinVaultPath(marksDir(paperAbsPath), ANNOTATIONS_FILE),
		);
		let cancelled = false;
		let burstTimer: number | null = null;
		let settleTimer: ReturnType<typeof setTimeout> | null = null;

		const schedule = () => {
			if (burstTimer !== null) return;
			burstTimer = window.setTimeout(() => {
				burstTimer = null;
				void reimport();
			}, ANNOTATIONS_REIMPORT_BURST_MS);
		};

		const reimport = async () => {
			if (cancelled) return;
			// The mount-time import is still filling the scope; comparing against
			// it now would re-import the same ids. Wait one burst and retry.
			if (!initialImportDoneRef.current || importingRef.current) {
				schedule();
				return;
			}
			const scope = annotationCap.forDocument(docId);
			const existing = scope
				.getAnnotations()
				.filter(isLiveAnnotation)
				.map((a) => a.object);
			const items = await loadAnnotationItems(paperAbsPath);
			if (cancelled) return;
			const plan = planAnnotationItemImport(items, existing);
			if (!plan.imports.length && !plan.highlightOverrides.length) return;
			importingRef.current = true;
			history?.invalidate([
				...plan.imports.map((item) => item.annotation.id),
				...plan.highlightOverrides.map((item) => item.id),
			]);
			if (plan.imports.length) scope.importAnnotations(plan.imports);
			if (plan.highlightOverrides.length) {
				const apply = () => scope.updateAnnotations(plan.highlightOverrides);
				if (history) history.withoutRecording(apply);
				else apply();
				scope.commit();
			}
			settleTimer = setTimeout(() => {
				settleTimer = null;
				if (cancelled) return;
				importingRef.current = false;
				rebuildHighlights();
			}, 0);
		};

		const unsub = listenVaultFileChangedGated((payload) => {
			const paths = [...payload.paths];
			if (payload.rename) {
				paths.push(payload.rename.from, payload.rename.to);
			}
			const hit = paths.filter((p) => normalizePathKey(p) === target);
			if (!hit.length) return;
			if (hit.every((p) => isRecentSelfWrite(p))) return;
			schedule();
		});
		return () => {
			cancelled = true;
			if (burstTimer !== null) window.clearTimeout(burstTimer);
			if (settleTimer !== null) {
				clearTimeout(settleTimer);
				importingRef.current = false;
			}
			unsub();
		};
	}, [
		annotationCap,
		docId,
		paperAbsPath,
		totalPages,
		rebuildHighlights,
		history,
	]);

	const createHighlights = useCallback(
		(
			pages: FormattedSelection[],
			color: HighlightColor,
			quote: string,
			translatedPages?: readonly VisibleSelectionPage[],
		) => {
			const scope = annotationCap?.forDocument(docId);
			if (!scope) return [] as { pageIndex: number; id: string }[];
			const created: { pageIndex: number; id: string }[] = [];
			runAnnotationBatch(() => {
				for (const page of pages) {
					const id = crypto.randomUUID();
					const translatedRects = translatedPages?.find(
						(item) => item.pageIndex === page.pageIndex,
					)?.rects;
					const custom: HighlightCustom = {
						app: "agentero",
						paletteKey: color,
						quote,
					};
					if (translatedRects?.length) custom.translatedRects = translatedRects;
					const obj: PdfHighlightAnnoObject = {
						type: PdfAnnotationSubtype.HIGHLIGHT,
						id,
						pageIndex: page.pageIndex,
						rect: page.rect,
						segmentRects: page.segmentRects,
						strokeColor: HIGHLIGHT_HEX[color],
						opacity: HIGHLIGHT_OPACITY,
						created: new Date(),
						custom,
					};
					scope.createAnnotation(page.pageIndex, obj);
					created.push({ pageIndex: page.pageIndex, id });
				}
			});
			return created;
		},
		[annotationCap, docId, runAnnotationBatch],
	);

	const updateHighlightComment = useCallback(
		(pageIndex: number, id: string, comment: string) => {
			const scope = annotationCap?.forDocument(docId);
			if (!scope) return;
			const tracked = scope.getAnnotationById(id);
			if (!tracked || !isLiveAnnotation(tracked)) return;
			if ((tracked.object.contents?.trim() ?? "") === comment.trim()) return;
			scope.updateAnnotation(pageIndex, id, {
				contents: comment.trim() || undefined,
			});
		},
		[annotationCap, docId],
	);

	const updateHighlightColor = useCallback(
		(pageIndex: number, id: string, color: HighlightColor) => {
			const scope = annotationCap?.forDocument(docId);
			if (!scope) return;
			const tracked = scope.getAnnotationById(id);
			if (
				!tracked ||
				!isLiveAnnotation(tracked) ||
				!isHighlightObject(tracked.object)
			) {
				return;
			}
			const obj = tracked.object;
			const custom = (obj.custom ?? {}) as HighlightCustom;
			if (
				custom.paletteKey === color &&
				obj.strokeColor === HIGHLIGHT_HEX[color]
			)
				return;
			scope.updateAnnotation(pageIndex, id, {
				strokeColor: HIGHLIGHT_HEX[color],
				custom: { ...custom, paletteKey: color },
			});
		},
		[annotationCap, docId],
	);

	useEffect(() => {
		if (!annotationCap) return;
		const queue = createAnnotationDeleteQueue(
			annotationCap.forDocument(docId),
			(error) =>
				notifyError(i18n.t("viewer:pdf.annotationDeleteFailed"), {
					description: error === undefined ? undefined : errorText(error),
				}),
			history
				? (action) => {
						history.withoutRecording(action);
						annotationCap.forDocument(docId).commit();
					}
				: undefined,
		);
		deleteQueueRef.current = queue;
		return () => {
			queue.dispose();
			if (deleteQueueRef.current === queue) deleteQueueRef.current = null;
		};
	}, [annotationCap, docId, history]);

	useEffect(() => {
		if (!annotationCap || !history) return;
		const replay = createAnnotationHistoryReplay(
			annotationCap.forDocument(docId),
			history,
			(error) => notifyError(errorText(error)),
		);
		historyReplayRef.current = replay;
		return () => {
			replay.dispose();
			if (historyReplayRef.current === replay) historyReplayRef.current = null;
		};
	}, [annotationCap, docId, history]);

	const deleteHighlightAnnotation = useCallback(
		(pageIndex: number, id: string) => {
			deleteQueueRef.current?.delete(pageIndex, id);
		},
		[],
	);

	return {
		runAnnotationBatch,
		replayAnnotationHistory,
		highlights,
		highlightsRef,
		highlightAnchors,
		citationLinks,
		rebuildHighlights,
		createHighlights,
		updateHighlightComment,
		updateHighlightColor,
		deleteHighlightAnnotation,
	};
}
