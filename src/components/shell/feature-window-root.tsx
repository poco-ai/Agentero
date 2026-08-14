/**
 * Lightweight root for `?window=feature&view=…` singleton popouts.
 * Opens the vault from query params and follows main-window active path.
 */

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { VoiceDefenseTrigger } from "@/components/agent/voice-defense-trigger";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
	type AnnotationRow,
	AnnotationsPanel,
	type AskRow,
	type VisualTraceRow,
} from "@/components/viewer/annotations-panel";
import { FiguresPanel } from "@/components/viewer/figures-panel";
import { ReferencesPanel } from "@/components/viewer/references-panel";
import { BacklinksPanel } from "@/components/wiki/backlinks-panel";
import { GraphPanel } from "@/components/wiki/graph-panel";
import {
	useLibraryStore,
	useSettings,
	useVaultStore,
	useWikiStore,
} from "@/hooks/use-app-stores";
import { applyAgentSessionHandoffOnce } from "@/lib/agent/agent-session-store";
import { normalizeAgentSourcePath } from "@/lib/agent/sources";
import { toVaultRelative } from "@/lib/core/path";
import { isMacOS, isTauri } from "@/lib/core/tauri";
import { isLibraryVirtualPath, isTrashVirtualPath } from "@/lib/paper/api";
import { paperDirFromPath } from "@/lib/paper/detect";
import { refreshLibrary } from "@/lib/paper/library-store";
import { listPdfVisualTraces } from "@/lib/pdf/agent-trace/io";
import { tracePreview } from "@/lib/pdf/agent-trace/schema";
import {
	loadPdfVisualTraceThumbnails,
	type PdfVisualTraceThumbnail,
} from "@/lib/pdf/agent-trace/thumbnail";
import type { PdfVisualSessionTrace } from "@/lib/pdf/agent-trace/types";
import {
	annotationWikilinkAlias,
	listPaperAnnotationSummaries,
	type PaperAnnotationSummary,
	wikiTargetForPaper,
} from "@/lib/pdf/annotation-ref";
import { listPdfAskThreads } from "@/lib/pdf/ask/io";
import { normalizeHighlightColor } from "@/lib/pdf/highlight/palette";
import {
	type FeatureViewType,
	readFeatureWindowView,
} from "@/lib/shell/feature-window";
import { openSettingsWindow } from "@/lib/shell/settings-window";
import {
	type AgentSessionOpenRequest,
	setAgentPanelMounted,
	uiStore,
} from "@/lib/shell/ui-store";
import {
	listenAgentOpenSession,
	listenAgentSessionHandoff,
	listenWorkspaceActive,
	type WorkspaceActiveChangedPayload,
} from "@/lib/shell/workspace-broadcast";
import { joinVaultPath } from "@/lib/vault";
import { openRecentVault } from "@/lib/vault/actions";
import { initVaultStore, refreshTree } from "@/lib/vault/store";
import { rebuildWikiAndNotify } from "@/lib/wiki/store";
import { navigateWiki, openGraphPath } from "@/lib/workspace/actions";
import { initWorkspaceStore } from "@/lib/workspace/store";

const AgentPanel = lazy(() =>
	import("@/components/agent/agent-panel").then((m) => ({
		default: m.AgentPanel,
	})),
);

function closeCurrentWindow() {
	if (!isTauri()) return;
	void (async () => {
		try {
			const { getCurrentWindow } = await import("@tauri-apps/api/window");
			await getCurrentWindow().close();
		} catch {
			// ignore
		}
	})();
}

function readFeatureQuery(): {
	vaultPath: string | null;
	activePath: string | null;
	paperTitle: string | null;
} {
	try {
		const params = new URLSearchParams(window.location.search);
		return {
			vaultPath: params.get("vault_path"),
			activePath: params.get("active_path"),
			paperTitle: params.get("paper_title"),
		};
	} catch {
		return { vaultPath: null, activePath: null, paperTitle: null };
	}
}

function viewTitleKey(
	view: FeatureViewType,
):
	| "labels.agent"
	| "labels.backlinks"
	| "titlebar.annotationsPanel"
	| "titlebar.referencesPanel"
	| "titlebar.figuresPanel" {
	switch (view) {
		case "agent":
			return "labels.agent";
		case "backlinks":
			return "labels.backlinks";
		case "annotations":
			return "titlebar.annotationsPanel";
		case "references":
			return "titlebar.referencesPanel";
		case "figures":
			return "titlebar.figuresPanel";
	}
}

function handleAgentOpenSource(source: string): void {
	const trimmed = normalizeAgentSourcePath(source);
	if (!trimmed) return;
	if (/^https?:\/\//i.test(trimmed)) {
		void import("@tauri-apps/plugin-opener")
			.then(({ openUrl }) => openUrl(trimmed))
			.catch(() => {
				window.open(trimmed, "_blank", "noopener,noreferrer");
			});
		return;
	}
	openGraphPath(trimmed);
}

function FeatureAnnotations({
	selectedPath,
	vaultPath,
	vaultPaperPaths,
}: {
	selectedPath: string | null;
	vaultPath: string | null;
	vaultPaperPaths: string[];
}) {
	const paperAbs = useMemo(() => {
		if (!selectedPath || !vaultPath) return null;
		if (
			isLibraryVirtualPath(selectedPath) ||
			isTrashVirtualPath(selectedPath)
		) {
			return null;
		}
		const relative = toVaultRelative(vaultPath, selectedPath);
		const paperDir = paperDirFromPath(relative, vaultPaperPaths);
		if (!paperDir) return null;
		return joinVaultPath(vaultPath, paperDir);
	}, [selectedPath, vaultPath, vaultPaperPaths]);

	const [diskSummaries, setDiskSummaries] = useState<PaperAnnotationSummary[]>(
		[],
	);
	const [diskAsks, setDiskAsks] = useState<AskRow[]>([]);
	const [diskVisuals, setDiskVisuals] = useState<PdfVisualSessionTrace[]>([]);
	const [visualThumbs, setVisualThumbs] = useState<
		Record<string, PdfVisualTraceThumbnail>
	>({});

	useEffect(() => {
		if (!paperAbs) {
			setDiskSummaries([]);
			setDiskAsks([]);
			setDiskVisuals([]);
			return;
		}
		let cancelled = false;
		void (async () => {
			const [summaries, asks, visuals] = await Promise.all([
				listPaperAnnotationSummaries(paperAbs),
				listPdfAskThreads(paperAbs),
				listPdfVisualTraces(paperAbs),
			]);
			if (cancelled) return;
			setDiskSummaries(summaries);
			setDiskVisuals(visuals);
			setDiskAsks(
				asks
					.filter((th) => th.messages.some((m) => m.role === "user"))
					.map((th) => {
						const firstUser = th.messages.find((m) => m.role === "user");
						return {
							id: th.id,
							page: th.anchor.page,
							preview:
								firstUser?.content.trim() || th.anchor.quote?.trim() || th.id,
							messageCount: th.messages.filter(
								(m) => m.role === "user" || m.role === "assistant",
							).length,
						};
					}),
			);
		})();
		return () => {
			cancelled = true;
		};
	}, [paperAbs]);

	useEffect(() => {
		let cancelled = false;
		void loadPdfVisualTraceThumbnails(paperAbs, diskVisuals).then((images) => {
			if (!cancelled) setVisualThumbs(images);
		});
		return () => {
			cancelled = true;
		};
	}, [paperAbs, diskVisuals]);

	const items = useMemo<AnnotationRow[]>(
		() =>
			diskSummaries
				.filter((s) => s.kind === "highlight")
				.map((s) => ({
					id: s.id,
					page: s.page,
					quote: s.quote,
					comment: s.comment,
					color: normalizeHighlightColor(s.color),
					linkAlias: annotationWikilinkAlias(null, s.preview),
				})),
		[diskSummaries],
	);

	const visualTraceRows = useMemo<VisualTraceRow[]>(
		() =>
			diskVisuals.length
				? [...diskVisuals]
						.sort(
							(a, b) =>
								a.page - b.page || (a.rects[0]?.y ?? 0) - (b.rects[0]?.y ?? 0),
						)
						.map((tr) => ({
							id: tr.id,
							page: tr.page,
							preview: tracePreview(tr, "Visual annotation", 160),
							linkAlias: annotationWikilinkAlias(null, tr.comment),
							thumbnail: visualThumbs[tr.id] ?? null,
						}))
				: diskSummaries
						.filter((s) => s.kind === "visual" || s.kind === "agent-trace")
						.map((s) => ({
							id: s.id,
							page: s.page,
							preview: s.preview,
							linkAlias: annotationWikilinkAlias(null, s.preview),
						})),
		[diskVisuals, diskSummaries, visualThumbs],
	);

	const wikiTarget = useMemo(() => {
		if (!paperAbs || !vaultPath) return null;
		const rel = toVaultRelative(vaultPath, paperAbs);
		return rel ? wikiTargetForPaper(rel, rel) : null;
	}, [paperAbs, vaultPath]);

	// Jump actions need the main-window PDF handle — list-only in the popout.
	return (
		<AnnotationsPanel
			items={items}
			asks={diskAsks}
			visualTraces={visualTraceRows}
			wikiTarget={wikiTarget}
			onJump={() => {}}
			onEdit={() => {}}
			onDelete={() => {}}
			onJumpAsk={() => {}}
			onDeleteAsk={() => {}}
			onJumpVisual={() => {}}
			onDeleteVisual={() => {}}
		/>
	);
}

export function FeatureWindowRoot() {
	const { t } = useTranslation(["app"]);
	const view = useMemo(() => readFeatureWindowView() ?? "agent", []);
	const bootQuery = useMemo(() => readFeatureQuery(), []);
	const isMac = useMemo(() => isMacOS(), []);
	const [ready, setReady] = useState(false);
	const [followed, setFollowed] = useState<WorkspaceActiveChangedPayload>({
		path: bootQuery.activePath,
		vaultPath: bootQuery.vaultPath,
		paperTitle: bootQuery.paperTitle,
	});

	const vaultPath = useVaultStore((s) => s.vaultPath);
	const vaultMdFiles = useVaultStore((s) => s.vaultMdFiles);
	const vaultDefenseMaterialFiles = useVaultStore(
		(s) => s.vaultDefenseMaterialFiles,
	);
	const vaultDirPaths = useVaultStore((s) => s.vaultDirPaths);
	const vaultPaperPaths = useVaultStore((s) => s.vaultPaperPaths);
	const paperMetaByRelPath = useLibraryStore((s) => s.paperMetaByRelPath);
	const paperTreeLabelMode = useSettings((s) => s.paperTreeLabelMode);
	const wikiIndexRevision = useWikiStore((s) => s.wikiIndexRevision);

	useState(() => {
		initVaultStore();
		initWorkspaceStore();
		return null;
	});

	useEffect(() => {
		setAgentPanelMounted(true);
		let cancelled = false;
		void (async () => {
			const vault = bootQuery.vaultPath;
			if (vault) {
				await openRecentVault(vault);
				if (!cancelled) {
					await refreshTree(vault);
					await rebuildWikiAndNotify(vault);
					await refreshLibrary();
				}
			}
			if (!cancelled) setReady(true);
		})();
		return () => {
			cancelled = true;
		};
	}, [bootQuery.vaultPath]);

	useEffect(() => {
		let unlisten: (() => void) | undefined;
		void listenWorkspaceActive((payload) => {
			setFollowed(payload);
		}).then((u) => {
			unlisten = u;
		});
		return () => {
			unlisten?.();
		};
	}, []);

	useEffect(() => {
		if (view !== "agent") return;
		let unlistenOpen: (() => void) | undefined;
		let unlistenHandoff: (() => void) | undefined;
		void listenAgentOpenSession((payload) => {
			const req = payload as AgentSessionOpenRequest;
			if (!req || typeof req !== "object" || !("nonce" in req)) return;
			uiStore.setState({ agentSessionOpenRequest: req });
		}).then((u) => {
			unlistenOpen = u;
		});
		// First handoff only — later retries must not clobber in-window chat.
		void listenAgentSessionHandoff((payload) => {
			applyAgentSessionHandoffOnce({
				sessions: payload.sessions,
				activeTabId: payload.activeTabId,
				draftLines: payload.draftLines,
			});
		}).then((u) => {
			unlistenHandoff = u;
		});
		return () => {
			unlistenOpen?.();
			unlistenHandoff?.();
		};
	}, [view]);

	useEffect(() => {
		const onKeyDown = (event: KeyboardEvent) => {
			const isEsc = event.key === "Escape";
			const isCloseWindow =
				(event.key === "w" || event.code === "KeyW") &&
				(event.metaKey || event.ctrlKey);
			if (isEsc || (isCloseWindow && !event.altKey && !event.shiftKey)) {
				event.preventDefault();
				closeCurrentWindow();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, []);

	const selectedPath = followed.path;
	const selectedPaperTitle = followed.paperTitle ?? null;
	const title = t(viewTitleKey(view));

	// Keep OS window caption in sync with locale (Host may have used a fallback).
	useEffect(() => {
		if (!isTauri()) return;
		void (async () => {
			try {
				const { getCurrentWindow } = await import("@tauri-apps/api/window");
				await getCurrentWindow().setTitle(title);
			} catch {
				// ignore
			}
		})();
	}, [title]);

	const referencesPaperPath = useMemo(() => {
		if (
			!selectedPath ||
			!vaultPath ||
			isLibraryVirtualPath(selectedPath) ||
			isTrashVirtualPath(selectedPath)
		) {
			return null;
		}
		const relative = toVaultRelative(vaultPath, selectedPath);
		return paperDirFromPath(relative, vaultPaperPaths);
	}, [selectedPath, vaultPath, vaultPaperPaths]);

	return (
		<div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
			<header className="flex h-8 shrink-0 items-center border-b bg-muted/40 select-none">
				{isMac ? (
					<div
						className="w-[92px] shrink-0 self-stretch"
						data-tauri-drag-region
					/>
				) : (
					<div className="w-2 shrink-0 self-stretch" data-tauri-drag-region />
				)}
				<div
					className="min-w-0 flex-1 truncate px-2 text-xs font-medium text-muted-foreground"
					data-tauri-drag-region
				>
					{title}
				</div>
				{view === "agent" && vaultPath ? (
					<TooltipProvider delayDuration={250}>
						<div className="flex shrink-0 items-center pr-2">
							<VoiceDefenseTrigger />
						</div>
					</TooltipProvider>
				) : null}
			</header>

			<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
				{!ready ? (
					<div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
						{t("windows.loading")}
					</div>
				) : view === "agent" ? (
					<Suspense fallback={null}>
						<AgentPanel
							vaultPath={vaultPath}
							selectedPath={selectedPath}
							selectedPaperTitle={selectedPaperTitle}
							vaultMarkdownPaths={vaultMdFiles}
							vaultDefenseMaterialPaths={vaultDefenseMaterialFiles}
							vaultDirectoryPaths={vaultDirPaths}
							vaultPaperPaths={vaultPaperPaths}
							paperMetaByRelPath={paperMetaByRelPath}
							paperTreeLabelMode={paperTreeLabelMode}
							className="min-h-0 h-full"
							title={title}
							autoFocus
							onOpenAgentSettings={() => openSettingsWindow("agent")}
							onOpenSource={handleAgentOpenSource}
						/>
					</Suspense>
				) : view === "backlinks" ? (
					<div className="flex h-full min-h-0 flex-col overflow-hidden">
						<BacklinksPanel
							vaultPath={vaultPath}
							selectedPath={selectedPath}
							onNavigate={(link) =>
								void navigateWiki({
									targetRaw: link.occurrence.targetRaw,
									path: link.targetPath ?? null,
									status: link.status,
									fragment: link.occurrence.fragment,
								})
							}
							className="min-h-0 basis-[42%] border-b"
							wikiIndexRevision={wikiIndexRevision}
						/>
						<GraphPanel
							vaultPath={vaultPath}
							selectedPath={selectedPath}
							onOpenPath={openGraphPath}
							className="min-h-0 flex-1"
							wikiIndexRevision={wikiIndexRevision}
						/>
					</div>
				) : view === "annotations" ? (
					<FeatureAnnotations
						selectedPath={selectedPath}
						vaultPath={vaultPath}
						vaultPaperPaths={vaultPaperPaths}
					/>
				) : view === "figures" ? (
					// Layout results live in the main-window PDF viewer memory;
					// the popout shows empty until sidecar persistence exists.
					<FiguresPanel
						documentId={null}
						viewerReady={false}
						onAnalyze={() => {}}
						onJump={() => {}}
					/>
				) : (
					<ReferencesPanel
						vaultPath={vaultPath}
						paperPath={referencesPaperPath}
						activeTabId={null}
					/>
				)}
			</div>
		</div>
	);
}
