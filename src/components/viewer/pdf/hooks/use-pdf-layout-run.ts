/**
 * Running PP-DocLayoutV3 for one document — or, far more often, loading the
 * `source/layout.json` sidecar a headless run already produced.
 *
 * Separate from hover and from the bulk-translate job because it owns a
 * different lifecycle: at most one abortable task per document, a headless queue
 * entry per open paper, and a sidecar file event that wakes the active viewer.
 * EmbedPDF's layout scope is re-created every render, so `layoutCapRef` stays in
 * `PdfViewerInner` and is injected.
 */

import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import type { useLayoutAnalysisCapability } from "@embedpdf/plugin-layout-analysis/react";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import {
	BackgroundTaskCancelledError,
	isBackgroundTaskCancelledError,
} from "@/lib/core/background-tasks";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { runLocalActivity } from "@/lib/core/tasks";
import { isTauri } from "@/lib/core/tauri";
import {
	enqueuePaperLayoutAnalysis,
	getLayoutDocumentResult,
	layoutAnalysisStore,
	layoutDocumentKey,
	readLayoutSidecar,
	runDocumentLayoutAnalysis,
	setLayoutOverlayVisible,
} from "@/lib/pdf/layout";
import {
	layoutSidecarNeedsViewerReload,
	layoutSidecarPath,
} from "@/lib/pdf/layout/io";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import { listenVaultFileChangedGated } from "@/lib/vault/file-change-gate";
import type { VaultFileChangedPayload } from "@/lib/vault/fs-watch";
import { normalizePathKey } from "@/lib/vault/path";

/**
 * `generatedAt` of the sidecar already merged into a viewer document.
 * Headless force re-runs write a new timestamp under another document id
 * and then drop that id, so the open tab must notice the change itself.
 */
const appliedLayoutSidecarAt = new Map<string, string>();

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
type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
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
	docCap: DocumentManagerCapability;
	docCapRef: RefObject<DocumentManagerCapability>;
	/** True for remote papers with no local sidecar; disables layout analysis. */
	isRemotePaper?: boolean;
	/**
	 * True for PDFs outside papers/ (plain viewer): no layout analysis at all,
	 * including the in-viewer auto-run loose PDFs otherwise get.
	 */
	plainViewer?: boolean;
	/**
	 * Dual-pane translation companion reuses the source pane's layout store /
	 * sidecar; it must not enqueue a second analysis pass on open.
	 */
	translationPane?: boolean;
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
	docCap,
	docCapRef,
	isRemotePaper = false,
	plainViewer = false,
	translationPane = false,
}: UsePdfLayoutRunOptions): PdfLayoutRun {
	const { t } = useTranslation("viewer");
	const layoutTaskRef = useRef<LayoutAnalysisTask | null>(null);
	const totalPagesRef = useRef(totalPages);
	totalPagesRef.current = totalPages;

	/** Failure toast that points at the provider settings (issue #656). */
	const notifyLayoutFailure = useCallback(
		(message: string) => {
			notifyError(t("pdf.layout.failed"), {
				description: message,
				action: {
					label: t("pdf.layout.openSettings"),
					onClick: () => openSettingsWindow("layout"),
				},
			});
		},
		[t],
	);

	/**
	 * Run layout analysis for this document.
	 * - force: re-run PP-DocLayoutV3 (PDF→JSON) even when source/layout.json exists
	 * - without force: prefer layout.json → merge → sidebar when paper has a sidecar
	 * - openFigures / showOverlay: UI side-effects for the manual Figures button
	 * - asBackgroundTask: surface progress in the IDE background-tasks panel
	 */
	const startLayoutAnalysis = useCallback(
		(opts?: StartLayoutAnalysisOptions) => {
			if (isRemotePaper || plainViewer) return;
			const docs = docCapRef.current ?? docCap;
			if (!docs?.isDocumentOpen(docId)) {
				if (opts?.notifyOnError !== false) {
					notifyError(t("figures.viewerUnavailable"));
				}
				return;
			}
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

					// True page sizes for the remote paddle backend (it renders pages itself).
					const pageSizeAt = (pageIndex: number) => {
						const docs = docCapRef.current ?? docCap;
						const size = docs?.getDocument(docId)?.pages[pageIndex]?.size;
						return size && size.width > 0 && size.height > 0 ? size : null;
					};

					void runDocumentLayoutAnalysis(la, docId, {
						paperAbsPath,
						totalPages: pages > 0 ? pages : null,
						force: opts?.force === true,
						pageSizeAt,
						isDocumentOpen: () =>
							docCapRef.current?.isDocumentOpen(docId) ?? false,
						onDone: () => {
							layoutTaskRef.current = null;
							if (opts?.showOverlay) {
								setLayoutOverlayVisible(docId, true);
							}
							// Note: figures now lives in the PDF viewer left overlay, not
							// the right sidebar. Callers that want the panel visible after
							// analysis should toggle it themselves (the panel button is
							// inside the viewer, so this is normally already open).
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
				void runLocalActivity(
					{
						kind: "layoutRun",
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
						notifyLayoutFailure(errorText(e));
					}
				});
				return;
			}

			void runCore().catch((e) => {
				if (isBackgroundTaskCancelledError(e)) return;
				if (opts?.notifyOnError === false) return;
				notifyLayoutFailure(errorText(e));
			});
		},
		[
			docId,
			paperAbsPath,
			paperRelPath,
			t,
			notifyLayoutFailure,
			layoutCapRef,
			docCap,
			docCapRef,
			isRemotePaper,
			plainViewer,
		],
	);
	const startLayoutAnalysisRef = useRef(startLayoutAnalysis);
	startLayoutAnalysisRef.current = startLayoutAnalysis;

	// Any open paper (active or not) → headless queue so multi-tab can all
	// land in the background-tasks panel. Local ONNX stays serial (cap 1);
	// the Paddle API backend is uncapped at JobCenter. Translation companions
	// inherit layout from the source pane / store copy — do not re-queue.
	useEffect(() => {
		if (translationPane || isRemotePaper || !paperAbsPath) return;
		enqueuePaperLayoutAnalysis({ paperAbsPath });
	}, [translationPane, isRemotePaper, paperAbsPath]);

	// Active viewer: pull layout into the tab store once sidecar exists, and
	// again whenever that file's parse is replaced. A force re-run writes the
	// new sidecar from a headless document id, then drops it; without this
	// reload the figures rail keeps the previous in-memory result until restart.
	// Loose PDFs (no paper folder) still analyze in-viewer.
	const layoutAutoStartedForDocRef = useRef<string | null>(null);
	useEffect(() => {
		if (translationPane || isRemotePaper || plainViewer) return;
		if (!isActive) return;
		if (!layoutCap || totalPages <= 0) return;
		if (!docCap?.isDocumentOpen(docId)) return;
		if (!layoutCap.forDocument(docId)) return;

		let cancelled = false;
		let unlisten: (() => void) | null = null;
		let pullTicket = 0;
		const sidecarKey = paperAbsPath
			? normalizePathKey(layoutSidecarPath(paperAbsPath))
			: null;
		const appliedKey = layoutDocumentKey(docId);

		const eventHitsSidecar = (payload: VaultFileChangedPayload) => {
			if (!sidecarKey) return false;
			const paths = [...payload.paths];
			if (payload.rename) {
				paths.push(payload.rename.from, payload.rename.to);
			}
			return paths.some((path) => normalizePathKey(path) === sidecarKey);
		};

		const pullSidecar = async () => {
			if (!paperAbsPath || cancelled) return;
			const ticket = ++pullTicket;
			const sidecar = await readLayoutSidecar(paperAbsPath);
			if (cancelled || ticket !== pullTicket) return;
			const next = sidecar
				? {
						generatedAt: sidecar.source.generatedAt,
						regionCount: sidecar.regions.length,
					}
				: null;
			if (
				!sidecar ||
				!layoutSidecarNeedsViewerReload(
					appliedLayoutSidecarAt.get(appliedKey),
					next,
				)
			) {
				return;
			}
			appliedLayoutSidecarAt.set(appliedKey, sidecar.source.generatedAt);
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

			try {
				if (paperAbsPath) {
					// Also when memory already has a result: the sidecar may have
					// been replaced while this tab was inactive and not listening.
					await pullSidecar();
					return;
				}
				if (getLayoutDocumentResult(docId)) return;

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
			}
		};

		if (paperAbsPath && isTauri()) {
			unlisten = listenVaultFileChangedGated((payload) => {
				if (cancelled || !eventHitsSidecar(payload)) return;
				void pullSidecar();
			});
		}
		void tryLoad();

		return () => {
			cancelled = true;
			unlisten?.();
			// Strict-mode remount / leave tab before result: allow retry on re-activate.
			if (!getLayoutDocumentResult(docId)) {
				layoutAutoStartedForDocRef.current = null;
			}
		};
	}, [
		translationPane,
		isRemotePaper,
		plainViewer,
		isActive,
		layoutCap,
		docCap,
		docId,
		totalPages,
		paperAbsPath,
		startLayoutAnalysis,
	]);

	return { startLayoutAnalysisRef, layoutTaskRef };
}
