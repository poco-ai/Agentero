/**
 * Lightweight root for `?window=feature&view=…` singleton popouts.
 * Opens the vault from query params and follows main-window active path.
 */

import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	AnnotationsPanel,
	type AskRow,
	type VisualTraceRow,
} from "@/components/viewer";
import {
	useLibraryStore,
	useSettings,
	useVaultStore,
} from "@/hooks/use-app-stores";
import { applyAgentSessionHandoffOnce } from "@/lib/agent/agent-session-store";
import { normalizeAgentSourcePath } from "@/lib/agent/sources";
import { toVaultRelative } from "@/lib/core/path";
import { isMacOS, isTauri } from "@/lib/core/tauri";
import { toSafeDisposer } from "@/lib/core/tauri-events";
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
import { refreshTree } from "@/lib/vault/store";
import { rebuildWikiAndNotify } from "@/lib/wiki/store";
import { openGraphPath } from "@/lib/workspace/actions";

const AgentPanel = lazy(() =>
	import("@/components/agent/agent-panel").then((m) => ({
		default: m.AgentPanel,
	})),
);
const TranslationView = lazy(() =>
	import("@/components/translation/translation-view").then((m) => ({
		default: m.TranslationView,
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
): "labels.agent" | "titlebar.annotationsPanel" | "windows.titleTranslation" {
	switch (view) {
		case "agent":
			return "labels.agent";
		case "annotations":
			return "titlebar.annotationsPanel";
		case "translation":
			return "windows.titleTranslation";
		default:
			return "labels.agent";
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
			asks={diskAsks}
			visualTraces={visualTraceRows}
			wikiTarget={wikiTarget}
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
	const vaultDirPaths = useVaultStore((s) => s.vaultDirPaths);
	const vaultPaperPaths = useVaultStore((s) => s.vaultPaperPaths);
	const paperMetaByRelPath = useLibraryStore((s) => s.paperMetaByRelPath);
	const paperTreeLabelMode = useSettings((s) => s.paperTreeLabelMode);

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

	useEffect(
		() =>
			toSafeDisposer(
				listenWorkspaceActive((payload) => {
					setFollowed(payload);
				}),
			),
		[],
	);

	useEffect(() => {
		if (view !== "agent") return;
		const offs = [
			toSafeDisposer(
				listenAgentOpenSession((payload) => {
					const req = payload as AgentSessionOpenRequest;
					if (!req || typeof req !== "object" || !("nonce" in req)) return;
					uiStore.setState({ agentSessionOpenRequest: req });
				}),
			),
			// First handoff only — later retries must not clobber in-window chat.
			toSafeDisposer(
				listenAgentSessionHandoff((payload) => {
					applyAgentSessionHandoffOnce({
						sessions: payload.sessions,
						activeTabId: payload.activeTabId,
						draftLines: payload.draftLines,
					});
				}),
			),
		];
		return () => {
			for (const off of offs) off();
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

	return (
		<div className="flex h-screen w-screen flex-col overflow-hidden bg-background">
			{isMac ? (
				<header className="flex h-8 shrink-0 items-center border-b bg-muted/40 select-none">
					<div
						className="w-[92px] shrink-0 self-stretch"
						data-tauri-drag-region
					/>
					<div
						className="min-w-0 flex-1 truncate px-2 text-xs font-medium text-muted-foreground"
						data-tauri-drag-region
					>
						{title}
					</div>
				</header>
			) : null}

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
				) : view === "annotations" ? (
					<FeatureAnnotations
						selectedPath={selectedPath}
						vaultPath={vaultPath}
						vaultPaperPaths={vaultPaperPaths}
					/>
				) : view === "translation" ? (
					<Suspense fallback={null}>
						<TranslationView
							selectedPath={selectedPath}
							vaultPath={vaultPath}
							vaultPaperPaths={vaultPaperPaths}
						/>
					</Suspense>
				) : null}
			</div>
		</div>
	);
}
