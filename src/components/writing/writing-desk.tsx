/**
 * Writing canvas: one project's source beside its PDF.
 * The reading dock stays mounted underneath and is not shown here.
 */

import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
	ResizableGroup,
	ResizableHandle,
	ResizablePanel,
} from "@/components/ui/resizable";
import { WritingFileTabs } from "@/components/writing/writing-file-tabs";
import { WritingHistory } from "@/components/writing/writing-history";
import { WritingPdfBar } from "@/components/writing/writing-pdf-bar";
import { WritingSyncButtons } from "@/components/writing/writing-sync-buttons";
import { WritingSyncTab } from "@/components/writing/writing-sync-tab";
import { useVaultStore, useWritingStore } from "@/hooks/use-app-stores";
import { useTexRoot } from "@/hooks/use-tex-root";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { normalizePath } from "@/lib/core/path";
import { cn } from "@/lib/core/utils";
import { localFileToArrayBuffer } from "@/lib/paper/media";
import { texBuildStore } from "@/lib/tex/build-state";
import { useTexLiveStatusStore } from "@/lib/tex-live/status";
import { readVaultFile } from "@/lib/vault";
import { persistTextFile } from "@/lib/workspace/persistence";
import { resolveTexPdfPath } from "@/lib/workspace/tex-compile";
import { compileTexOnManualSave } from "@/lib/workspace/viewer-actions";
import { writingFileReloadStore } from "@/lib/writing/history";
import { selectManuscript } from "@/lib/writing/store";

const TextEditor = lazy(() =>
	import("@/components/viewer/text-editor").then((mod) => ({
		default: mod.TextEditor,
	})),
);
const PdfViewer = lazy(() =>
	import("@/components/viewer/pdf/pdf-viewer").then((mod) => ({
		default: mod.PdfViewer,
	})),
);
const TexLiveViewer = lazy(() =>
	import("@/components/viewer/texlive/tex-live-viewer").then((mod) => ({
		default: mod.TexLiveViewer,
	})),
);

type PdfState = {
	status: "loading" | "ready" | "missing";
	bytes: ArrayBuffer | null;
	path: string | null;
};

export function WritingDesk() {
	const { t } = useTranslation(["sidebar", "app"]);
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const activeRoot = useWritingStore((s) => s.activeRoot);
	const compileRoot = useTexRoot(activeRoot);
	const activeFile = useWritingStore((s) => s.activeFile);
	const discovered = useWritingStore((s) => s.manuscripts);
	const discovering = useWritingStore((s) => s.discovering);
	const historyActive = useWritingStore((s) => s.historyActive);
	const syncActive = useWritingStore((s) => s.syncActive);
	const [splitPosition, setSplitPosition] = useState(58);
	const [liveRoot, setLiveRoot] = useState<string | null>(null);
	const livePreview = activeRoot != null && liveRoot === activeRoot;
	const fallbackRoot =
		activeRoot || discovering ? null : (discovered[0]?.rootFile ?? null);

	useEffect(() => {
		if (!vaultPath || activeRoot || !fallbackRoot) return;
		selectManuscript(fallbackRoot);
	}, [vaultPath, activeRoot, fallbackRoot]);

	if (!vaultPath) return null;
	if (!activeRoot) {
		if (fallbackRoot) return null;
		return (
			<div className="mx-auto flex h-full w-full max-w-sm flex-col justify-center gap-3 px-6">
				<p className="text-muted-foreground text-sm">
					{discovering ? t("writing.loading") : t("writing.emptyTitle")}
				</p>
			</div>
		);
	}

	return (
		<div className="relative h-full min-h-0">
			<ResizableGroup
				orientation="horizontal"
				className="h-full min-h-0"
				onLayoutChange={(layout) =>
					setSplitPosition(layout["writing-editor"] ?? 58)
				}
			>
				<ResizablePanel
					id="writing-editor"
					defaultSize="58"
					minSize="24"
					className="min-h-0 min-w-0"
				>
					<div className="flex h-full min-h-0 min-w-0 flex-col">
						<div className="flex h-9 shrink-0 items-stretch border-b border-border bg-muted/70">
							<WritingFileTabs />
						</div>
						<div className="flex min-h-0 min-w-0 flex-1 flex-col">
							{historyActive ? (
								<WritingHistory />
							) : syncActive ? (
								<WritingSyncTab vaultPath={vaultPath} />
							) : activeFile ? (
								<Suspense
									fallback={
										<p className="text-muted-foreground px-3 py-2 text-sm">
											{t("writing.loadingFiles")}
										</p>
									}
								>
									<ProjectEditor path={activeFile} />
								</Suspense>
							) : null}
						</div>
					</div>
				</ResizablePanel>
				<ResizableHandle className="z-30" />
				<ResizablePanel
					id="writing-pdf"
					defaultSize="42"
					minSize="20"
					className="min-h-0 min-w-0"
				>
					<div className="flex h-full min-h-0 min-w-0 flex-col">
						<div className="flex h-9 shrink-0 items-stretch border-b border-border bg-muted/70">
							<WritingPdfBar
								rootFile={compileRoot ?? activeRoot}
								livePreview={livePreview}
								onLivePreviewChange={(live) =>
									setLiveRoot(live ? activeRoot : null)
								}
							/>
						</div>
						<div className="min-h-0 flex-1">
							<ProjectPdf
								rootFile={compileRoot ?? activeRoot}
								vaultPath={vaultPath}
								livePreview={livePreview}
							/>
						</div>
					</div>
				</ResizablePanel>
			</ResizableGroup>
			{/* Keep controls outside the resize group so its document-level hit testing ignores them. */}
			<WritingSyncButtons activeFile={activeFile} position={splitPosition} />
		</div>
	);
}

function ProjectEditor({ path }: { path: string }) {
	const { t } = useTranslation("sidebar");
	const [seed, setSeed] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const reloadToken = useStore(writingFileReloadStore, (state) =>
		state.path === "*" || state.path === normalizePath(path) ? state.token : 0,
	);

	useEffect(() => {
		let cancelled = false;
		const generation = reloadToken;
		setSeed(null);
		setFailed(false);
		void readVaultFile(path)
			.then((text) => {
				if (!cancelled && generation === reloadToken) setSeed(text);
			})
			.catch((error) => {
				if (cancelled) return;
				setFailed(true);
				notifyError(errorText(error));
			});
		return () => {
			cancelled = true;
		};
	}, [path, reloadToken]);

	if (failed) return null;
	if (seed == null) {
		return (
			<p className="text-muted-foreground px-3 py-2 text-sm">
				{t("writing.loadingFiles")}
			</p>
		);
	}

	return (
		<TextEditor
			key={`${path}:${reloadToken}`}
			seed={seed}
			path={path}
			reloadKey={0}
			active
			texLiveOwner="writing"
			onPersist={persistTextFile}
			onDirtyChange={() => {}}
			onManualSave={(saved) => {
				void compileTexOnManualSave(saved);
			}}
			hideLintFooter
			className="min-h-0 flex-1"
		/>
	);
}

export function ProjectPdf({
	rootFile,
	vaultPath,
	livePreview,
	active = true,
	instanceId = "writing",
}: {
	rootFile: string;
	vaultPath: string;
	livePreview: boolean;
	active?: boolean;
	instanceId?: string;
}) {
	const { t } = useTranslation("sidebar");
	const buildToken = useStore(texBuildStore, (state) => {
		const snap = state.byRoot[normalizePath(rootFile)];
		if (!snap) return "";
		if (snap.status !== "succeeded") return snap.status;
		return `ok:${snap.result?.pdfPath ?? ""}:${snap.jobId ?? ""}`;
	});
	const [pdf, setPdf] = useState<PdfState>({
		status: "loading",
		bytes: null,
		path: null,
	});

	useEffect(() => {
		if (livePreview) return;
		const revision = buildToken;
		let cancelled = false;
		setPdf((current) => ({
			...current,
			status: current.bytes ? "ready" : "loading",
		}));
		void (async () => {
			const snap = texBuildStore.getState().byRoot[normalizePath(rootFile)];
			let path: string | null =
				snap?.status === "succeeded" && revision.startsWith("ok:")
					? (snap.result?.pdfPath ?? null)
					: null;
			if (!path) {
				try {
					path = await resolveTexPdfPath(rootFile);
				} catch {
					path = null;
				}
			}
			if (!path) {
				if (!cancelled) {
					setPdf((current) =>
						current.bytes
							? current
							: { status: "missing", bytes: null, path: null },
					);
				}
				return;
			}
			const bytes = await localFileToArrayBuffer(path);
			if (cancelled) return;
			setPdf((current) =>
				bytes
					? { status: "ready", bytes, path }
					: current.bytes
						? current
						: { status: "missing", bytes: null, path: null },
			);
		})();
		return () => {
			cancelled = true;
		};
	}, [rootFile, buildToken, livePreview]);

	if (livePreview) {
		return (
			<div className="relative h-full min-h-0">
				<Suspense
					fallback={
						<p className="text-muted-foreground px-3 py-2 text-sm">
							{t("writing.previewLoading")}
						</p>
					}
				>
					<TexLiveViewer rootPath={rootFile} vaultPath={vaultPath} />
				</Suspense>
				<LivePreviewBadge rootPath={rootFile} />
			</div>
		);
	}

	if (pdf.status === "ready" && pdf.bytes && pdf.path) {
		return (
			<Suspense
				fallback={
					<p className="text-muted-foreground px-3 py-2 text-sm">
						{t("writing.previewLoading")}
					</p>
				}
			>
				<PdfViewer
					key={pdf.path}
					source={null}
					sourceBytes={pdf.bytes}
					docId={`${instanceId}:${normalizePath(pdf.path)}`}
					vaultPath={vaultPath}
					isActive={active}
					plainViewer
					showBottomBar
					texRootPath={rootFile}
					pdfPath={pdf.path}
					syncTexScope="writing"
					className="h-full w-full"
				/>
			</Suspense>
		);
	}

	return (
		<div className="text-muted-foreground flex h-full items-center justify-center px-6 text-center text-sm">
			{pdf.status === "loading"
				? t("writing.previewLoading")
				: t("writing.previewEmpty")}
		</div>
	);
}

function LivePreviewBadge({ rootPath }: { rootPath: string }) {
	const { t } = useTranslation("sidebar");
	const status = useTexLiveStatusStore(
		(state) => state.byRoot[rootPath]?.status ?? "starting",
	);
	return (
		<div
			role="status"
			className="pointer-events-none absolute top-2 right-5 z-10 flex items-center gap-1.5 rounded-md border border-border/70 bg-background/85 px-2 py-1 text-[11px] text-muted-foreground shadow-raised backdrop-blur"
		>
			<span
				className={cn(
					"size-1.5 rounded-full",
					status === "live"
						? "bg-emerald-500"
						: status === "failed"
							? "bg-red-500"
							: "bg-amber-500",
				)}
				aria-hidden
			/>
			{t("fileTree.liveCompile")}
		</div>
	);
}
