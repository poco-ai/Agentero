/**
 * Compile controls on the PDF pane, in the same place Overleaf puts Recompile.
 */

import {
	Check,
	ChevronDown,
	CloudUpload,
	History,
	Loader2,
	MonitorPlay,
	Play,
	Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { WritingProblems } from "@/components/writing/writing-problems";
import {
	useWritingProject,
	useWritingProjectRelative,
} from "@/hooks/use-writing-project";
import { commands } from "@/lib/core/bindings";
import { notifyError } from "@/lib/core/notify";
import { normalizePath } from "@/lib/core/path";
import { cancelTask } from "@/lib/core/tasks";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import { ensureTexBuildEvents, texBuildStore } from "@/lib/tex/build-state";
import { rememberTexEngine } from "@/lib/tex/engine";
import { getVaultPath } from "@/lib/vault/store";
import { compileTexProject } from "@/lib/workspace/actions";
import {
	cleanTexAuxFiles,
	engineChoiceForRoot,
	initTexEngines,
	type TexEngineChoice,
	texCompileStore,
} from "@/lib/workspace/tex-compile";
import {
	COMPILE_SUCCESS_FLASH_MS,
	compileButtonDisplay,
	compileButtonPhase,
	shouldFlashCompileSuccess,
} from "@/lib/writing/compile-button";
import {
	readWritingGitHub,
	type WritingGitHubLink,
} from "@/lib/writing/github";
import {
	closeWritingHistory,
	openWritingHistory,
	openWritingSync,
	writingStore,
} from "@/lib/writing/store";
import { readWritingSyncPrefs } from "@/lib/writing/sync-prefs";
import {
	isWritingAutoSyncPaused,
	resumeWritingAutoSync,
	uploadWritingProject,
} from "@/lib/writing/upload";

export function WritingPdfBar({
	rootFile,
	livePreview,
	onLivePreviewChange,
	manageSync = true,
}: {
	rootFile: string;
	livePreview: boolean;
	onLivePreviewChange: (live: boolean) => void;
	manageSync?: boolean;
}) {
	const { t } = useTranslation(["sidebar", "latexBuild"]);
	const key = normalizePath(rootFile);
	const engines = useStore(texCompileStore, (state) => state.engines);
	const enginesLoading = useStore(
		texCompileStore,
		(state) => state.enginesLoading,
	);
	const compilingPath = useStore(
		texCompileStore,
		(state) => state.compilingPath,
	);
	const snapshot = useStore(texBuildStore, (state) => state.byRoot[key]);
	const phase = compileButtonPhase({
		compilingPath,
		rootFile: key,
		status: snapshot?.status,
	});
	const [trackedPhase, setTrackedPhase] = useState(phase);
	const [successFlash, setSuccessFlash] = useState(false);
	if (phase !== trackedPhase) {
		setTrackedPhase(phase);
		setSuccessFlash(shouldFlashCompileSuccess(trackedPhase, phase));
	}
	useEffect(() => {
		if (!successFlash) return;
		const timer = window.setTimeout(
			() => setSuccessFlash(false),
			COMPILE_SUCCESS_FLASH_MS,
		);
		return () => window.clearTimeout(timer);
	}, [successFlash]);
	const display = compileButtonDisplay(phase, successFlash);
	const running = display === "running";
	const ready = enginesLoading || engines.length > 0;
	const vault = getVaultPath();
	const project = useWritingProjectRelative(vault, rootFile);
	const manifest = useWritingProject(vault, rootFile);
	const historyActive = useStore(writingStore, (state) => state.historyActive);
	const [engineChoice, setEngineChoice] = useState<TexEngineChoice | null>(
		null,
	);
	const [syncing, setSyncing] = useState(false);
	const [github, setGithub] = useState<WritingGitHubLink | null>(() =>
		vault && project ? readWritingGitHub(vault, project) : null,
	);
	const [syncMode, setSyncMode] = useState(() =>
		vault ? readWritingSyncPrefs(vault).mode : "manual",
	);
	const [syncMinutes, setSyncMinutes] = useState(() =>
		vault ? readWritingSyncPrefs(vault).intervalMinutes : 15,
	);

	useEffect(() => {
		initTexEngines();
		void ensureTexBuildEvents();
	}, []);

	useEffect(() => {
		if (
			manifest.status === "pending" ||
			(enginesLoading && engines.length === 0)
		)
			return;
		let cancelled = false;
		void engineChoiceForRoot(key)
			.then((choice) => {
				if (!cancelled) setEngineChoice(choice);
			})
			.catch(() => {
				if (!cancelled) setEngineChoice(null);
			});
		return () => {
			cancelled = true;
		};
	}, [key, engines, enginesLoading, manifest]);

	useEffect(() => {
		const refresh = () => {
			const current = getVaultPath();
			setGithub(
				current && project ? readWritingGitHub(current, project) : null,
			);
			const prefs = current ? readWritingSyncPrefs(current) : null;
			setSyncMode(prefs?.mode ?? "manual");
			setSyncMinutes(prefs?.intervalMinutes ?? 15);
		};
		refresh();
		window.addEventListener("storage", refresh);
		return () => window.removeEventListener("storage", refresh);
	}, [project]);

	async function runSync(link: WritingGitHubLink, quiet = false) {
		if (!project) return;
		setSyncing(true);
		try {
			await uploadWritingProject(project, link, quiet);
		} finally {
			setSyncing(false);
		}
	}

	const runSyncRef = useRef(runSync);
	runSyncRef.current = runSync;
	const seenJob = useRef<string | null>(null);

	useEffect(() => {
		return texBuildStore.subscribe((state) => {
			const snap = state.byRoot[key];
			if (
				!snap?.jobId ||
				snap.status === "running" ||
				snap.status === "cancelled"
			) {
				return;
			}
			if (seenJob.current === snap.jobId) return;
			seenJob.current = snap.jobId;
			if (!manageSync || !project || syncMode !== "onCompile" || !github)
				return;
			if (isWritingAutoSyncPaused()) return;
			void runSyncRef.current(github, true);
		});
	}, [key, project, syncMode, github, manageSync]);

	useEffect(() => {
		if (!manageSync || !project || syncMode !== "interval" || !github) return;
		const timer = window.setInterval(
			() => {
				if (isWritingAutoSyncPaused()) return;
				void runSyncRef.current(github, true);
			},
			syncMinutes * 60 * 1000,
		);
		return () => window.clearInterval(timer);
	}, [project, syncMode, syncMinutes, github, manageSync]);

	function syncProject() {
		resumeWritingAutoSync();
		const current = getVaultPath();
		const link =
			current && project ? readWritingGitHub(current, project) : null;
		setGithub(link);
		if (!link) {
			openWritingSync();
			return;
		}
		void runSync(link);
	}

	async function toggleLivePreview() {
		if (livePreview) {
			onLivePreviewChange(false);
			return;
		}
		if (!isTauri()) return;
		const status = await commands.rtexStatus();
		if (!status.ok || !status.data?.available) {
			notifyError(
				status.error?.message ??
					status.data?.error ??
					t("fileTree.livePreviewUnavailable"),
			);
			return;
		}
		onLivePreviewChange(true);
	}

	return (
		<div className="flex h-full min-w-0 flex-1 items-center gap-1 overflow-hidden pr-2 pl-1">
			<div
				className="inline-flex items-stretch"
				data-compile-state={display}
				aria-busy={running || undefined}
			>
				<Button
					type="button"
					size="sm"
					className={cn(
						"relative rounded-r-none",
						running && "disabled:opacity-100",
					)}
					disabled={!ready || running}
					aria-disabled={!ready || running || undefined}
					aria-label={running ? t("writing.compiling") : undefined}
					onClick={() => {
						if (!ready || running) return;
						void compileTexProject(rootFile);
					}}
				>
					{/* Compiling keeps the idle label in flow but hidden, so the split
					    control does not change width while only the spinner shows. */}
					<span
						className={cn(
							"inline-flex items-center gap-1",
							running && "invisible",
						)}
						aria-hidden={running || undefined}
					>
						{display === "succeeded" ? (
							<Check aria-hidden />
						) : (
							<Play aria-hidden />
						)}
						{display === "succeeded"
							? t("fileTree.compileSuccess")
							: t("writing.recompile")}
					</span>
					{running ? (
						<Loader2
							className="absolute inset-0 m-auto animate-spin motion-reduce:animate-none"
							aria-hidden
						/>
					) : null}
				</Button>
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							type="button"
							size="sm"
							className="rounded-l-none border-l border-primary-foreground/25 px-1.5"
							aria-label={t("writing.compileMenu")}
							disabled={!ready}
						>
							<ChevronDown aria-hidden />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="start">
						<DropdownMenuItem
							disabled={running}
							onSelect={() => {
								void compileTexProject(rootFile, "force");
							}}
						>
							{t("latexBuild:rebuild")}
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={running}
							onSelect={() => {
								void compileTexProject(rootFile, "clean");
							}}
						>
							{t("latexBuild:cleanRebuild")}
						</DropdownMenuItem>
						<DropdownMenuItem
							disabled={running}
							onSelect={() => {
								void cleanTexAuxFiles(rootFile);
							}}
						>
							{t("fileTree.cleanAux")}
						</DropdownMenuItem>
						<DropdownMenuSeparator />
						<DropdownMenuLabel>{t("fileTree.latexEngine")}</DropdownMenuLabel>
						{engineChoice?.locked ? (
							<DropdownMenuLabel className="text-[11px] font-normal">
								{t("latexPanel.engineFromFile")}
							</DropdownMenuLabel>
						) : null}
						{enginesLoading ? (
							<DropdownMenuItem disabled>
								{t("fileTree.detectingEngines")}
							</DropdownMenuItem>
						) : engines.length === 0 ? (
							<DropdownMenuItem disabled>
								{t("fileTree.noLatexEngine")}
							</DropdownMenuItem>
						) : (
							engines.map((engine) => {
								const selected = engineChoice?.engineId === engine.id;
								return (
									<DropdownMenuItem
										key={engine.id}
										disabled={engineChoice?.locked}
										onSelect={() => {
											if (!engineChoice || engineChoice.locked) return;
											rememberTexEngine(engineChoice.rootPath, engine.id);
											setEngineChoice({
												...engineChoice,
												engineId: engine.id,
											});
										}}
										className="justify-between"
									>
										<span>{engine.label}</span>
										<Check
											className={cn("size-4", !selected && "invisible")}
											aria-hidden
										/>
									</DropdownMenuItem>
								);
							})
						)}
						<DropdownMenuSeparator />
						<DropdownMenuItem
							onSelect={() => void toggleLivePreview()}
							className="justify-between"
						>
							<span className="flex items-center gap-1.5">
								<MonitorPlay className="size-4" aria-hidden />
								{t("fileTree.liveCompile")}
							</span>
							<Check
								className={cn("size-4", !livePreview && "invisible")}
								aria-hidden
							/>
						</DropdownMenuItem>
						{snapshot?.status === "running" && snapshot.jobId ? (
							<DropdownMenuItem
								onSelect={() => {
									if (snapshot.jobId) cancelTask(snapshot.jobId);
								}}
							>
								<Square aria-hidden />
								{t("latexBuild:stop")}
							</DropdownMenuItem>
						) : null}
					</DropdownMenuContent>
				</DropdownMenu>
			</div>
			<WritingProblems rootFile={rootFile} />
			<span className="min-w-0 flex-1" />
			<Button
				type="button"
				variant="ghost"
				size="sm"
				aria-pressed={historyActive}
				className={cn(
					"shrink-0 text-muted-foreground",
					historyActive && "bg-muted text-foreground",
				)}
				onClick={() =>
					historyActive ? closeWritingHistory() : openWritingHistory()
				}
			>
				<History aria-hidden />
				{t("writing.history")}
			</Button>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				className="shrink-0 text-muted-foreground"
				aria-label={
					syncing
						? t("writing.syncing")
						: github
							? t("writing.syncTo", { repo: github.label })
							: t("writing.sync")
				}
				disabled={syncing}
				onClick={syncProject}
			>
				{syncing ? (
					<Loader2 className="animate-spin" aria-hidden />
				) : (
					<CloudUpload aria-hidden />
				)}
				{syncing ? t("writing.syncing") : t("writing.sync")}
			</Button>
		</div>
	);
}
