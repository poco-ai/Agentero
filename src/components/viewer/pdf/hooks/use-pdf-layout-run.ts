/**
 * Running PP-DocLayoutV3 for one document — or, far more often, loading the
 * `source/layout.json` sidecar a headless run already produced.
 *
 * Separate from hover and from the bulk-translate job because it owns a
 * different lifecycle: at most one abortable task per document, a headless queue
 * entry per open paper, and a poll that waits for a sibling tab (or the CLI) to
 * finish writing the sidecar. EmbedPDF's layout scope is re-created every
 * render, so `layoutCapRef` stays in `PdfViewerInner` and is injected.
 */

import type { useLayoutAnalysisCapability } from "@embedpdf/plugin-layout-analysis/react";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import {
	BackgroundTaskCancelledError,
	enqueueBackgroundTask,
	isBackgroundTaskCancelledError,
} from "@/lib/core/background-tasks";
import { notifyError } from "@/lib/core/notify";
import {
	enqueuePaperLayoutAnalysis,
	getLayoutDocumentResult,
	layoutAnalysisStore,
	readLayoutSidecar,
	runDocumentLayoutAnalysis,
	setLayoutOverlayVisible,
} from "@/lib/pdf/layout";

/** In-flight EmbedPDF layout task (abortable, at most one per document). */
export type LayoutAnalysisTask = Awaited<
	ReturnType<typeof runDocumentLayoutAnalysis>
>;

/** Options for the manual Figures button, the handle, and the silent auto-run. */
export type StartLayoutAnalysisOptions = {
	/** Re-run PP-DocLayoutV3 (PDF→JSON) even when `source/layout.json` exists. */
	force?: boolean;
	openFigures?: boolean;
	showOverlay?: boolean;
	/** Surface progress in the IDE background-tasks panel. */
	asBackgroundTask?: boolean;
	/** When false, skip notifyError (auto-run reports through the tasks panel). */
	notifyOnError?: boolean;
};

type LayoutCapability = ReturnType<
	typeof useLayoutAnalysisCapability
>["provides"];

export type UsePdfLayoutRunOptions = {
	docId: string;
	/** Paper folder holding the `layout.json` sidecar (null for loose PDFs). */
	paperAbsPath: string | null;
	/** Vault-relative path, used as the background-task label. */
	paperRelPath: string | null;
	/**
	 * Workspace active tab. Dock may keep inactive PDFs mounted; only the active
	 * viewer pulls the sidecar into the tab store.
	 */
	isActive: boolean;
	totalPages: number;
	/** The value gates the auto-run effect; the ref must never become a dep. */
	layoutCap: LayoutCapability;
	layoutCapRef: RefObject<LayoutCapability>;
};

export type PdfLayoutRun = {
	/** Latest `startLayoutAnalysis`, for the imperative handle. */
	startLayoutAnalysisRef: RefObject<
		(opts?: StartLayoutAnalysisOptions) => void
	>;
	/** In-flight layout task; the handle aborts it on unregister. */
	layoutTaskRef: RefObject<LayoutAnalysisTask | null>;
};

export function usePdfLayoutRun({
	docId,
	paperAbsPath,
	paperRelPath,
	isActive,
	totalPages,
	layoutCap,
	layoutCapRef,
}: UsePdfLayoutRunOptions): PdfLayoutRun {
	const { t } = useTranslation("viewer");
	const layoutTaskRef = useRef<LayoutAnalysisTask | null>(null);
	const totalPagesRef = useRef(totalPages);
	totalPagesRef.current = totalPages;

	/**
	 * Run layout analysis for this document.
	 * - force: re-run PP-DocLayoutV3 (PDF→JSON) even when source/layout.json exists
	 * - without force: prefer layout.json → merge → sidebar when paper has a sidecar
	 * - openFigures / showOverlay: UI side-effects for the manual Figures button
	 * - asBackgroundTask: surface progress in the IDE background-tasks panel
	 */
	const startLayoutAnalysis = useCallback(
		(opts?: StartLayoutAnalysisOptions) => {
			const la = layoutCapRef.current?.forDocument(docId);
			if (!la) {
				if (opts?.notifyOnError !== false) {
					notifyError(t("pdf.layout.unavailable"));
				}
				return;
			}
			layoutTaskRef.current?.abort({
				type: "no-document",
				message: "superseded",
			});
			const pages = totalPagesRef.current;
			const paperLabel =
				paperRelPath || paperAbsPath?.split(/[/\\]/).pop() || docId;

			const runCore = (hooks?: { signal?: AbortSignal }) =>
				new Promise<void>((resolve, reject) => {
					let settled = false;
					const finish = (fn: () => void) => {
						if (settled) return;
						settled = true;
						hooks?.signal?.removeEventListener("abort", onAbort);
						fn();
					};
					const onAbort = () => {
						layoutTaskRef.current?.abort({
							type: "no-document",
							message: "cancelled",
						});
						layoutTaskRef.current = null;
						finish(() => reject(new BackgroundTaskCancelledError()));
					};
					if (hooks?.signal?.aborted) {
						onAbort();
						return;
					}
					hooks?.signal?.addEventListener("abort", onAbort);

					void runDocumentLayoutAnalysis(la, docId, {
						paperAbsPath,
						totalPages: pages > 0 ? pages : null,
						force: opts?.force === true,
						onDone: () => {
							layoutTaskRef.current = null;
							if (opts?.showOverlay) {
								setLayoutOverlayVisible(docId, true);
							}
							if (opts?.openFigures) {
								void import("@/lib/shell/ui-store").then(({ openRightTab }) =>
									openRightTab("figures"),
								);
							}
							finish(() => resolve());
						},
						onError: (message, aborted) => {
							layoutTaskRef.current = null;
							finish(() => {
								if (aborted) {
									reject(new BackgroundTaskCancelledError());
									return;
								}
								reject(new Error(message));
							});
						},
					})
						.then((task) => {
							layoutTaskRef.current = task;
							// Cache hit resolves via onDone before returning null.
							if (task == null && !settled) {
								// onDone should have run; if not, resolve to avoid hang.
								finish(() => resolve());
							}
						})
						.catch((e) => {
							layoutTaskRef.current = null;
							finish(() =>
								reject(e instanceof Error ? e : new Error(String(e))),
							);
						});
				});

			if (opts?.asBackgroundTask) {
				void enqueueBackgroundTask(
					{
						kind: "parse",
						title: i18n.t("app:tasks.layoutAnalysis"),
						detail: paperLabel,
					},
					async ({ setProgress, setDetail, signal }) => {
						/**
						 * Mirror layoutAnalysisStore.ui — same overall % and copy as the
						 * Figures sidebar (message + page/total or pct), not per-page stages.
						 */
						const syncFromLayoutUi = () => {
							const { ui, activeDocumentId } = layoutAnalysisStore.getState();
							if (activeDocumentId != null && activeDocumentId !== docId) {
								return;
							}
							if (ui.stage !== "running") return;

							if (typeof ui.progress === "number") {
								setProgress(ui.progress);
							}

							const page =
								typeof ui.page === "number" && ui.page > 0
									? ui.page
									: typeof ui.completed === "number"
										? ui.completed
										: null;
							const total =
								typeof ui.total === "number" && ui.total > 0 ? ui.total : null;
							const message = ui.message?.trim() || t("figures.analyzing");
							const pageLine =
								total != null && page != null
									? t("figures.progressPages", { page, total })
									: typeof ui.progress === "number"
										? t("figures.progressPct", {
												pct: Math.round(ui.progress),
											})
										: null;
							setDetail(pageLine ? `${message} · ${pageLine}` : message);
						};

						setProgress(0);
						setDetail(t("pdf.layout.preparingModel"));
						const unsub = layoutAnalysisStore.subscribe(syncFromLayoutUi);
						syncFromLayoutUi();
						try {
							await runCore({ signal });
						} finally {
							unsub();
						}
					},
				).catch((e) => {
					if (isBackgroundTaskCancelledError(e)) return;
					if (opts?.notifyOnError !== false) {
						const message = e instanceof Error ? e.message : String(e);
						notifyError(t("pdf.layout.failed"), { description: message });
					}
				});
				return;
			}

			void runCore().catch((e) => {
				if (isBackgroundTaskCancelledError(e)) return;
				if (opts?.notifyOnError === false) return;
				const message = e instanceof Error ? e.message : String(e);
				notifyError(t("pdf.layout.failed"), { description: message });
			});
		},
		[docId, paperAbsPath, paperRelPath, t, layoutCapRef],
	);
	const startLayoutAnalysisRef = useRef(startLayoutAnalysis);
	startLayoutAnalysisRef.current = startLayoutAnalysis;

	// Any open paper (active or not) → headless queue so multi-tab can all
	// land in the background-tasks panel. ONNX still serial (concurrency:1).
	useEffect(() => {
		if (!paperAbsPath) return;
		enqueuePaperLayoutAnalysis({ paperAbsPath });
	}, [paperAbsPath]);

	// Active viewer: pull layout into the tab store once sidecar exists.
	// Headless may still be writing it for this paper (or a sibling tab);
	// poll until ready. Loose PDFs (no paper folder) still analyze in-viewer.
	const layoutAutoStartedForDocRef = useRef<string | null>(null);
	useEffect(() => {
		if (!isActive) return;
		if (!layoutCap || totalPages <= 0) return;
		if (getLayoutDocumentResult(docId)) return;
		if (!layoutCap.forDocument(docId)) return;

		let cancelled = false;
		let pollTimer: ReturnType<typeof setTimeout> | null = null;
		/** Stop polling after ~15 min so a permanent headless failure does not spin. */
		const pollDeadline = Date.now() + 15 * 60 * 1000;

		const clearPoll = () => {
			if (pollTimer != null) {
				clearTimeout(pollTimer);
				pollTimer = null;
			}
		};

		const loadSilent = () => {
			if (layoutAutoStartedForDocRef.current === docId) return;
			layoutAutoStartedForDocRef.current = docId;
			startLayoutAnalysis({
				force: false,
				openFigures: false,
				showOverlay: false,
				asBackgroundTask: false,
				notifyOnError: false,
			});
		};

		const tryLoad = async () => {
			if (cancelled) return;
			if (getLayoutDocumentResult(docId)) return;

			try {
				if (paperAbsPath) {
					const hasSidecar = Boolean(await readLayoutSidecar(paperAbsPath));
					if (cancelled) return;
					if (getLayoutDocumentResult(docId)) return;
					if (hasSidecar) {
						loadSilent();
						return;
					}
					// Sidecar not ready yet — headless job may be queued/running.
					if (Date.now() < pollDeadline) {
						pollTimer = setTimeout(() => {
							void tryLoad();
						}, 1500);
					} else if (layoutAutoStartedForDocRef.current === docId) {
						layoutAutoStartedForDocRef.current = null;
					}
					return;
				}

				// No paper folder (loose PDF): only the active tab can run in-viewer.
				if (layoutAutoStartedForDocRef.current === docId) return;
				layoutAutoStartedForDocRef.current = docId;
				startLayoutAnalysis({
					force: false,
					openFigures: false,
					showOverlay: false,
					asBackgroundTask: true,
					notifyOnError: false,
				});
			} catch {
				if (layoutAutoStartedForDocRef.current === docId) {
					layoutAutoStartedForDocRef.current = null;
				}
				if (!cancelled && paperAbsPath && Date.now() < pollDeadline) {
					pollTimer = setTimeout(() => {
						void tryLoad();
					}, 2500);
				}
			}
		};

		void tryLoad();

		return () => {
			cancelled = true;
			clearPoll();
			// Strict-mode remount / leave tab before result: allow retry on re-activate.
			if (!getLayoutDocumentResult(docId)) {
				layoutAutoStartedForDocRef.current = null;
			}
		};
	}, [
		isActive,
		layoutCap,
		docId,
		totalPages,
		paperAbsPath,
		startLayoutAnalysis,
	]);

	return { startLayoutAnalysisRef, layoutTaskRef };
}
