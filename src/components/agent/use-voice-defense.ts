/**
 * Voice defense orchestration: preparation recovery, Voice lease, live session,
 * and debrief. UI lives in `voice-defense-dialog.tsx` and the act components.
 */
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SelectionContext } from "@/lib/agent/selection-store";
import { isBackgroundTaskCancelledError } from "@/lib/core/background-tasks";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import type { PaperMetadata } from "@/lib/paper";
import {
	joinVaultPath,
	readVaultFile,
	vaultPathExists,
	writeVaultFile,
} from "@/lib/vault";
import { refreshTreeQuiet } from "@/lib/vault/store";
import {
	acquireVoiceDefenseSession,
	buildDefenseBootstrap,
	buildDefenseContextPatch,
	buildDefenseDebrief,
	buildDefenseRefocusPrompt,
	buildVoiceTranscriptMarkdown,
	cancelDefensePreparation,
	cancelDefenseReview,
	cancelVoiceAuth,
	canRecoverPreparation,
	clampPlannedDurationMinutes,
	clearPreparationRecovery,
	clearVoiceDefenseSessionLease,
	closeCurrentVivaWindow,
	completeDefensePreparation,
	confirmDefensePreparation,
	connectVoiceAuth,
	consumeVivaOpenRequest,
	createPaperSnapshot,
	createVaultPreparationStorage,
	type DefenseDebrief,
	DefensePreparationFailedError,
	type DefensePreparationManifest,
	type DefenseQuestion,
	type DefenseSessionReview,
	describeVoiceAuthError,
	disconnectVoiceAuth,
	findLatestReusableDefensePreparationForPaper,
	findReusableDefensePreparation,
	getVoiceAuthStatus,
	isDefenseReviewActive,
	isVoiceDefenseSessionActive,
	listDefensePreparations,
	listVoiceDefenseHistory,
	loadDefenseArtifact,
	loadDefensePreparation,
	nextVoiceSessionStartedAt,
	planPreparedDefenseEnter,
	preparationFailureDescription,
	preparedDefenseEnterPhase,
	RUNNING_PREPARATION_STATUSES,
	readPlannedDurationMinutes,
	readPreparationRecovery,
	readStoredDifficulty,
	readStoredLanguage,
	readStoredScenario,
	refreshDefensePreparation,
	releaseVoiceDefenseSession,
	resumeDefensePreparation,
	runPreparedDefenseEnter,
	shouldHandoffVoiceSession,
	startDefensePreparation,
	startDefenseReview,
	subscribeDefensePreparations,
	subscribeVivaOpenRequests,
	trackViva,
	upsertVoiceCaption,
	VOICE_AUTH_CHANGED_EVENT,
	type VoiceAuthStatus,
	type VoiceCaption,
	VoiceCaptionPacer,
	type VoiceConnectionStatus,
	VoiceDefenseClient,
	type VoiceDefenseClosePhase,
	type VoiceDefenseHistoryEntry,
	type VoiceDifficulty,
	type VoiceScenario,
	VoiceStartGate,
	voiceDefenseErrorCode,
	voiceTranscriptFileName,
	waitForPreparationChildrenIdle,
	writePlannedDurationMinutes,
	writePreparationRecovery,
	writeStoredDifficulty,
	writeStoredLanguage,
	writeStoredScenario,
} from "@/lib/voice-defense";

export type VoiceDialogPhase = VoiceDefenseClosePhase;

export type VoiceDefenseDialogProps = {
	vaultPath: string | null;
	currentFileLabel: string;
	focusedMaterialPath: string | null;
	materialOptions: Array<{
		path: string;
		kind: "file" | "directory";
		label: string;
	}>;
	paperMetadata: PaperMetadata | null;
	selectedPaperTitle: string | null;
	selectedAgentId?: string | null;
	modelId?: string | null;
	reasoningEffort?: string | null;
	selections: SelectionContext[];
	onOpenSource?: (source: string) => void;
	/** Fill a dedicated native window instead of a portal over the workbench. */
	windowMode?: boolean;
};

function paperSnapshotMetadata(
	metadata: PaperMetadata | null,
): Record<string, string | number | boolean | null> {
	if (!metadata) return {};
	return {
		title: metadata.title,
		authors: metadata.authors.join(", "),
		creators: metadata.creators?.length
			? JSON.stringify(metadata.creators)
			: null,
		tags: metadata.tags.length ? JSON.stringify(metadata.tags) : null,
		type: metadata.type,
		year: metadata.year ?? null,
		date: metadata.date ?? null,
		abstract: metadata.abstract ?? null,
		publication: metadata.publication ?? null,
		volume: metadata.volume ?? null,
		issue: metadata.issue ?? null,
		pages: metadata.pages ?? null,
		publisher: metadata.publisher ?? null,
		place: metadata.place ?? null,
		series: metadata.series ?? null,
		language: metadata.language ?? null,
		doi: metadata.doi ?? null,
		arxivId: metadata.arxiv_id ?? null,
		isbn: metadata.isbn ?? null,
		issn: metadata.issn ?? null,
		pmid: metadata.pmid ?? null,
		bibtexKey: metadata.bibtex_key ?? null,
		citationCount: metadata.citation_count ?? null,
		zoteroItemType: metadata.zotero_item_type ?? null,
		metadataSource: metadata.meta_source ?? null,
		summary: metadata.summary ?? null,
		bodySource: metadata.body_source ?? null,
		bodyQuality: metadata.body_quality ?? null,
	};
}

async function availableTranscriptPath(vaultPath: string, startedAt: Date) {
	const base = voiceTranscriptFileName(startedAt).replace(/\.md$/i, "");
	for (let index = 0; index < 100; index += 1) {
		const suffix = index === 0 ? "" : `-${index + 1}`;
		const relative = `voice-defense/${base}${suffix}.md`;
		if (!(await vaultPathExists(joinVaultPath(vaultPath, relative)))) {
			return relative;
		}
	}
	throw new Error("No available Voice transcript filename");
}

export function useVoiceDefense({
	windowMode = false,
	vaultPath,
	currentFileLabel,
	focusedMaterialPath,
	materialOptions,
	paperMetadata,
	selectedPaperTitle,
	selectedAgentId,
	modelId,
	reasoningEffort,
	selections,
	onOpenSource,
}: VoiceDefenseDialogProps) {
	const { t, i18n } = useTranslation("agent");
	const [open, setOpen] = useState(windowMode);
	const [phase, setPhase] = useState<VoiceDialogPhase>("prepare");
	const [connectionStatus, setConnectionStatus] =
		useState<VoiceConnectionStatus>("connecting");
	const [context, setContext] = useState("");
	const [source, setSource] = useState("");
	const [selectedMaterialPaths, setSelectedMaterialPaths] = useState<string[]>(
		[],
	);
	const [materialSearch, setMaterialSearch] = useState("");
	const [instruction, setInstruction] = useState("");
	const [preparationLoading, setPreparationLoading] = useState(false);
	const [preparationError, setPreparationError] = useState(false);
	const [voiceStarting, setVoiceStarting] = useState(false);
	const [startError, setStartError] = useState("");
	const [preparation, setPreparation] =
		useState<DefensePreparationManifest | null>(null);
	const [recoveryRunId] = useState<string | null>(
		() => readPreparationRecovery()?.runId ?? null,
	);
	const [activePreparationRunId, setActivePreparationRunId] = useState<
		string | null
	>(null);
	const [captions, setCaptions] = useState<VoiceCaption[]>([]);
	const [stageCaptions, setStageCaptions] = useState<VoiceCaption[]>([]);
	const [muted, setMuted] = useState(false);
	const [errorText, setErrorText] = useState("");
	const [savedPath, setSavedPath] = useState<string | null>(null);
	const [savingTranscript, setSavingTranscript] = useState(false);
	const [plannedMinutes, setPlannedMinutes] = useState<number | null>(() =>
		readPlannedDurationMinutes(),
	);
	const [scenario, setScenario] = useState<VoiceScenario>(() =>
		readStoredScenario(),
	);
	const [defenseLanguage, setDefenseLanguage] = useState<"en" | "zh-CN">(() =>
		readStoredLanguage(i18n.language.startsWith("zh") ? "zh-CN" : "en"),
	);
	const [difficulty, setDifficulty] = useState<VoiceDifficulty>(() =>
		readStoredDifficulty(),
	);
	const [reusableManifest, setReusableManifest] =
		useState<DefensePreparationManifest | null>(null);
	const [history, setHistory] = useState<VoiceDefenseHistoryEntry[]>([]);
	const [debrief, setDebrief] = useState<DefenseDebrief | null>(null);
	const [review, setReview] = useState<DefenseSessionReview | null>(null);
	const [reviewPath, setReviewPath] = useState<string | null>(null);
	const [reviewing, setReviewing] = useState(false);
	const reviewQuestionsRef = useRef<DefenseQuestion[]>([]);
	const sessionPreparationRunIdRef = useRef<string | null>(null);
	const sessionMaterialsRef = useRef<string[]>([]);
	const [authStatus, setAuthStatus] = useState<VoiceAuthStatus | null>(null);
	const [authBusy, setAuthBusy] = useState(false);
	const [startedAt, setStartedAt] = useState<Date | null>(null);
	const [endedAt, setEndedAt] = useState<Date | null>(null);
	const clientRef = useRef<VoiceDefenseClient | null>(null);
	const audioRef = useRef<HTMLAudioElement>(null);
	const captionsRef = useRef<VoiceCaption[]>([]);
	const captionPacerRef = useRef(new VoiceCaptionPacer());
	const committeePlaybackRef = useRef(false);
	const startedAtRef = useRef<Date | null>(null);
	const finishingRef = useRef<number | null>(null);
	const authErrorRef = useRef<string | null>(null);
	const loadedBriefKeyRef = useRef<string | null>(null);
	const voicePreparationRunIdRef = useRef<string | null>(null);
	const openRef = useRef(false);
	openRef.current = open;
	const startGateRef = useRef(new VoiceStartGate());
	const reopenBackgroundPreparationRef = useRef(false);
	const recoveryAutoOpenAttemptedRef = useRef(false);
	const closingNativeRef = useRef(false);
	const phaseRef = useRef<VoiceDialogPhase>(phase);
	phaseRef.current = phase;
	const preparationScopeRef = useRef<{
		vaultPath: string | null;
		runId: string | null;
	}>({
		vaultPath,
		runId: null,
	});
	const language: "en" | "zh-CN" = i18n.language.startsWith("zh")
		? "zh-CN"
		: "en";
	const title =
		selectedPaperTitle?.trim() ||
		currentFileLabel ||
		t("voiceDefense.untitled");
	const materialByPath = useMemo(() => {
		const map = new Map(materialOptions.map((item) => [item.path, item]));
		if (focusedMaterialPath && !map.has(focusedMaterialPath)) {
			map.set(focusedMaterialPath, {
				path: focusedMaterialPath,
				kind: /\.[^/]+$/.test(focusedMaterialPath) ? "file" : "directory",
				label:
					currentFileLabel ||
					focusedMaterialPath.split("/").pop() ||
					focusedMaterialPath,
			});
		}
		return map;
	}, [currentFileLabel, focusedMaterialPath, materialOptions]);
	const selectedMaterials = useMemo(
		() =>
			selectedMaterialPaths.flatMap((path) => {
				const material = materialByPath.get(path);
				return material
					? [
							{
								path: material.path,
								kind: material.kind,
								title: material.label,
							},
						]
					: [];
			}),
		[materialByPath, selectedMaterialPaths],
	);
	const defenseTitle =
		selectedMaterials.length === 1
			? (selectedMaterials[0]?.title ?? title)
			: t("voiceDefense.materials.bundleTitle", {
					count: selectedMaterials.length,
				});
	const displayTitle = selectedMaterials.length > 0 ? defenseTitle : title;
	const filteredMaterialOptions = useMemo(() => {
		const query = materialSearch.trim().toLocaleLowerCase();
		return (
			[...materialByPath.values()]
				.filter(
					(item) =>
						!query ||
						item.label.toLocaleLowerCase().includes(query) ||
						item.path.toLocaleLowerCase().includes(query),
				)
				// The open paper is the most likely pick — keep it on top, but the
				// selection itself always stays with the user.
				.sort((a, b) =>
					a.path === focusedMaterialPath
						? -1
						: b.path === focusedMaterialPath
							? 1
							: 0,
				)
				.slice(0, 120)
		);
	}, [focusedMaterialPath, materialByPath, materialSearch]);
	const releaseOwnedVoiceSession = useCallback((leaseId: string | null) => {
		if (!leaseId) return;
		releaseVoiceDefenseSession(leaseId);
		startGateRef.current.clearLeaseIf(leaseId);
	}, []);
	const preparationCurrent = useMemo(
		() => ({
			title: defenseTitle,
			materials: selectedMaterials,
			instruction,
			metadata: selectedMaterialPaths.includes(focusedMaterialPath ?? "")
				? paperSnapshotMetadata(paperMetadata)
				: {},
			selections: selections
				.filter((selection) =>
					selectedMaterials.some((material) =>
						material.kind === "file"
							? selection.sourcePath === material.path
							: selection.sourcePath === material.path ||
								selection.sourcePath.startsWith(`${material.path}/`),
					),
				)
				.map((selection) => ({
					text: selection.text,
					sourcePath: selection.sourcePath || undefined,
					page: selection.page,
				})),
		}),
		[
			defenseTitle,
			focusedMaterialPath,
			instruction,
			paperMetadata,
			selectedMaterialPaths,
			selectedMaterials,
			selections,
		],
	);
	const preparationInput = useCallback(() => {
		if (!vaultPath || selectedMaterials.length === 0) return null;
		return {
			vaultRoot: vaultPath,
			paperPath: selectedMaterials[0].path,
			...preparationCurrent,
			language,
			agentId: selectedAgentId || undefined,
			modelId: modelId || undefined,
			reasoningEffort: reasoningEffort || undefined,
		};
	}, [
		language,
		modelId,
		preparationCurrent,
		reasoningEffort,
		selectedMaterials,
		selectedAgentId,
		vaultPath,
	]);

	useEffect(() => {
		if (!vaultPath || !activePreparationRunId) return;
		return subscribeDefensePreparations((states) => {
			const state = states.find(
				(item) =>
					item.vaultRoot === vaultPath && item.runId === activePreparationRunId,
			);
			if (state?.manifest) {
				if (state.manifest.status === "cancelled") {
					setPreparation(null);
					setPreparationError(false);
					setPreparationLoading(false);
					setContext("");
					setSource("");
					loadedBriefKeyRef.current = null;
					clearPreparationRecovery(state.manifest.runId);
					return;
				}
				setPreparationError(false);
				setPreparation(structuredClone(state.manifest));
			}
		});
	}, [activePreparationRunId, vaultPath]);

	useEffect(() => {
		if (!open || !vaultPath || !preparation?.briefPath) return;
		const key = `${preparation.runId}:${preparation.nodes.synthesis.artifactId ?? "draft"}:${preparation.briefPath}`;
		if (loadedBriefKeyRef.current === key) return;
		let cancelled = false;
		void readVaultFile(joinVaultPath(vaultPath, preparation.briefPath))
			.then((brief) => {
				if (cancelled) return;
				loadedBriefKeyRef.current = key;
				setContext(brief);
				setSource(preparation.briefPath ?? "");
			})
			.catch((error) => {
				if (cancelled) return;
				notifyError(t("voiceDefense.preparation.loadFailed"), {
					description: error instanceof Error ? error.message : String(error),
				});
			});
		return () => {
			cancelled = true;
		};
	}, [open, preparation, t, vaultPath]);

	useEffect(() => {
		if (
			!open ||
			!vaultPath ||
			selectedMaterials.length === 0 ||
			activePreparationRunId
		) {
			setReusableManifest(null);
			return;
		}
		let cancelled = false;
		const timer = window.setTimeout(() => {
			void (async () => {
				try {
					const snapshot = await createPaperSnapshot({
						vaultRoot: vaultPath,
						paperPath: selectedMaterials[0].path,
						...preparationCurrent,
					});
					if (cancelled) return;
					const found = await findReusableDefensePreparation(
						vaultPath,
						snapshot.snapshotSha256,
					);
					if (cancelled) return;
					const currentReady =
						preparation &&
						(preparation.status === "awaiting_review" ||
							preparation.status === "ready" ||
							preparation.status === "completed");
					if (found && currentReady && preparation.runId === found.runId) {
						setReusableManifest(null);
						return;
					}
					setReusableManifest(found);
				} catch {
					if (!cancelled) setReusableManifest(null);
				}
			})();
		}, 400);
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
		};
	}, [
		activePreparationRunId,
		open,
		preparation,
		preparationCurrent,
		selectedMaterials,
		vaultPath,
	]);

	useEffect(() => {
		if (!open || !vaultPath || selectedMaterialPaths.length === 0) {
			setHistory([]);
			return;
		}
		let cancelled = false;
		void listVoiceDefenseHistory(vaultPath, selectedMaterialPaths)
			.then((entries) => {
				if (!cancelled) setHistory(entries);
			})
			.catch(() => {
				if (!cancelled) setHistory([]);
			});
		return () => {
			cancelled = true;
		};
	}, [open, selectedMaterialPaths, vaultPath]);

	// Unmount only: a callback identity change must not cancel an in-flight start.
	// biome-ignore lint/correctness/useExhaustiveDependencies: unmount-only cleanup
	useEffect(() => {
		return () => {
			const leaseId = startGateRef.current.leaseId;
			startGateRef.current.invalidate(Boolean(clientRef.current));
			const client = clientRef.current;
			clientRef.current = null;
			if (client) {
				void client.close().finally(() => {
					releaseOwnedVoiceSession(leaseId);
				});
			} else {
				releaseOwnedVoiceSession(leaseId);
			}
		};
	}, []);

	useEffect(() => {
		if (!open || !isTauri()) return;
		let cancelled = false;
		let unlisten: UnlistenFn | undefined;

		const applyStatus = (next: VoiceAuthStatus) => {
			if (cancelled) return;
			setAuthStatus(next);
			setAuthBusy(false);
			if (next.error && next.error !== authErrorRef.current) {
				authErrorRef.current = next.error;
				notifyError(t("voiceDefense.auth.connectFailed"), {
					description: describeVoiceAuthError(
						next.error,
						t("voiceDefense.auth.credentialOwnerConflict"),
					),
				});
			} else if (!next.error) {
				authErrorRef.current = null;
			}
		};

		void listen<VoiceAuthStatus>(VOICE_AUTH_CHANGED_EVENT, (event) => {
			applyStatus(event.payload);
		})
			.then((dispose) => {
				if (cancelled) dispose();
				else unlisten = dispose;
			})
			.catch(() => undefined);

		void getVoiceAuthStatus()
			.then(applyStatus)
			.catch((error) => {
				if (cancelled) return;
				const message = error instanceof Error ? error.message : String(error);
				setAuthStatus({ connected: false, connecting: false, error: message });
			});

		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [open, t]);

	const reset = useCallback(() => {
		const leaseToDrop = startGateRef.current.invalidate(
			Boolean(clientRef.current),
		);
		setVoiceStarting(false);
		if (leaseToDrop) releaseOwnedVoiceSession(leaseToDrop);
		setPhase("prepare");
		setConnectionStatus("connecting");
		setContext("");
		setSource("");
		// Materials are always an explicit user choice; the focused paper is only
		// surfaced as the top suggestion in the picker, never auto-selected.
		setSelectedMaterialPaths([]);
		setMaterialSearch("");
		setInstruction("");
		setPreparation(null);
		setPreparationError(false);
		setPreparationLoading(false);
		loadedBriefKeyRef.current = null;
		setCaptions([]);
		captionsRef.current = [];
		captionPacerRef.current.reset();
		setStageCaptions([]);
		committeePlaybackRef.current = false;
		setMuted(false);
		setErrorText("");
		setSavedPath(null);
		setSavingTranscript(false);
		setStartedAt(null);
		setEndedAt(null);
		setDebrief(null);
		setReview(null);
		setReviewPath(null);
		setReviewing(false);
		setReusableManifest(null);
		setHistory([]);
		reviewQuestionsRef.current = [];
		startedAtRef.current = null;
		voicePreparationRunIdRef.current = null;
		sessionPreparationRunIdRef.current = null;
		sessionMaterialsRef.current = [];
		finishingRef.current = null;
	}, [releaseOwnedVoiceSession]);

	const openDialog = () => {
		const recovery = readPreparationRecovery();
		if (canRecoverPreparation(recovery, vaultPath, focusedMaterialPath)) {
			openRef.current = true;
			setOpen(true);
			setPhase("prepare");
			setPreparationError(false);
			setPreparationLoading(true);
			preparationScopeRef.current = {
				vaultPath: recovery.vaultPath,
				runId: recovery.runId,
			};
			void loadDefensePreparation(recovery.vaultPath, recovery.runId)
				.then(async (manifest) => {
					if (!manifest || !openRef.current) return;
					const refreshed = await refreshDefensePreparation(
						recovery.vaultPath,
						recovery.runId,
					);
					if (!openRef.current) return;
					setSelectedMaterialPaths(
						refreshed.snapshot.materials.map((material) => material.path),
					);
					setInstruction(refreshed.snapshot.instruction);
					if (refreshed.status === "cancelled") {
						clearPreparationRecovery(recovery.runId);
						setPreparation(null);
						setPreparationError(false);
						setPreparationLoading(false);
						setContext("");
						setSource("");
						loadedBriefKeyRef.current = null;
						return;
					}
					setPreparation(refreshed);
					setPreparationError(refreshed.status === "failed");
					if (refreshed.stale) {
						clearPreparationRecovery(recovery.runId);
						setPreparationLoading(false);
						setContext("");
						setSource("");
						loadedBriefKeyRef.current = null;
					}
				})
				.catch((error) => {
					if (!openRef.current) return;
					setPreparationError(true);
					notifyError(t("voiceDefense.preparation.loadFailed"), {
						description: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(() => setPreparationLoading(false));
			return;
		}
		if (reopenBackgroundPreparationRef.current && preparation) {
			reopenBackgroundPreparationRef.current = false;
			openRef.current = true;
			setOpen(true);
			return;
		}
		reopenBackgroundPreparationRef.current = false;
		reset();
		openRef.current = true;
		setOpen(true);
		const runId = activePreparationRunId;
		if (vaultPath && runId) {
			setPreparationLoading(true);
			void loadDefensePreparation(vaultPath, runId)
				.then((manifest) => {
					if (!manifest || !openRef.current) return;
					setPreparation(manifest);
					setSelectedMaterialPaths(
						manifest.snapshot.materials.map((material) => material.path),
					);
					setInstruction(manifest.snapshot.instruction);
				})
				.finally(() => setPreparationLoading(false));
		} else if (vaultPath && focusedMaterialPath) {
			void listDefensePreparations(vaultPath)
				.then(async (summaries) => {
					const interrupted = summaries.find(
						(summary) =>
							summary.paperPath === focusedMaterialPath &&
							RUNNING_PREPARATION_STATUSES.has(summary.status),
					);
					if (interrupted) {
						setPreparationLoading(true);
						try {
							const manifest = await refreshDefensePreparation(
								vaultPath,
								interrupted.runId,
							);
							if (!openRef.current) return;
							preparationScopeRef.current = {
								vaultPath,
								runId: manifest.runId,
							};
							setPreparation(manifest);
							setSelectedMaterialPaths(
								manifest.snapshot.materials.map((material) => material.path),
							);
							setInstruction(manifest.snapshot.instruction);
						} finally {
							setPreparationLoading(false);
						}
						return;
					}
					const reusable = await findLatestReusableDefensePreparationForPaper(
						vaultPath,
						focusedMaterialPath,
					);
					if (!reusable || !openRef.current) return;
					setSelectedMaterialPaths(
						reusable.snapshot.materials.map((material) => material.path),
					);
					setInstruction(reusable.snapshot.instruction);
				})
				.catch((error) => {
					if (!openRef.current) return;
					setPreparationLoading(false);
					notifyError(t("voiceDefense.preparation.loadFailed"), {
						description: error instanceof Error ? error.message : String(error),
					});
				});
		}
	};
	const openDialogRef = useRef(openDialog);
	openDialogRef.current = openDialog;
	useEffect(() => {
		if (open) trackViva("dialog_opened", { enter: "immediate" });
	}, [open]);
	useEffect(() => {
		if (!windowMode) return;
		openDialogRef.current();
	}, [windowMode]);
	// Palette/menu entry points latch a request until this dialog is mounted.
	useEffect(() => {
		if (windowMode) return;
		const handleRequest = () => {
			if (!consumeVivaOpenRequest()) return;
			if (!openRef.current) openDialogRef.current();
		};
		handleRequest();
		return subscribeVivaOpenRequests(handleRequest);
	}, [windowMode]);
	useEffect(() => {
		if (
			recoveryAutoOpenAttemptedRef.current ||
			open ||
			!recoveryRunId ||
			!vaultPath ||
			!focusedMaterialPath ||
			readPreparationRecovery()?.runId !== recoveryRunId ||
			readPreparationRecovery()?.vaultPath !== vaultPath ||
			readPreparationRecovery()?.paperPath !== focusedMaterialPath
		) {
			return;
		}
		recoveryAutoOpenAttemptedRef.current = true;
		openDialogRef.current();
	}, [focusedMaterialPath, open, recoveryRunId, vaultPath]);

	const isCurrentPreparationScope = (vaultRoot: string, runId: string) =>
		preparationScopeRef.current.vaultPath === vaultRoot &&
		preparationScopeRef.current.runId === runId;

	const reportStartFailure = (
		reason: string,
		message: string,
		title = t("voiceDefense.startFailed"),
	) => {
		trackViva("session_start_failed", { reason, message });
		setStartError(message);
		setErrorText(message);
		notifyError(title, { description: message });
	};

	const isDialogOpen = () => windowMode || openRef.current;

	const beginVoiceStart = (options?: {
		takeoverStaleLease?: boolean;
	}): number | null => {
		const operation = startGateRef.current.begin({
			open: isDialogOpen(),
			hasClient: Boolean(clientRef.current),
			sessionActive: isVoiceDefenseSessionActive(),
			acquire: acquireVoiceDefenseSession,
			takeoverStaleLease: options?.takeoverStaleLease,
			releaseStale: options?.takeoverStaleLease
				? clearVoiceDefenseSessionLease
				: undefined,
		});
		if (operation === null) {
			trackViva("session_start_requested", {
				blocked: true,
				open: isDialogOpen(),
				hasClient: Boolean(clientRef.current),
				sessionActive: isVoiceDefenseSessionActive(),
				starting: startGateRef.current.isStarting,
			});
			return null;
		}
		setVoiceStarting(true);
		return operation;
	};

	const releaseVoiceStart = (operation: number) => {
		const leaseToDrop = startGateRef.current.release(
			operation,
			Boolean(clientRef.current),
		);
		setVoiceStarting(startGateRef.current.isStarting);
		if (leaseToDrop) releaseOwnedVoiceSession(leaseToDrop);
	};

	const invalidateVoiceStart = () => {
		const leaseToDrop = startGateRef.current.invalidate(
			Boolean(clientRef.current),
		);
		setVoiceStarting(false);
		if (leaseToDrop) releaseOwnedVoiceSession(leaseToDrop);
	};

	const runPreparation = async (resume: boolean) => {
		if (startGateRef.current.isStarting || isVoiceDefenseSessionActive())
			return;
		const input = preparationInput();
		if (!input) return;
		let runId: string | null = null;
		setPreparationError(false);
		setStartError("");
		trackViva("preparation_started", {
			resume,
			materials: input.materials?.length ?? 0,
		});
		try {
			if (!resume) {
				loadedBriefKeyRef.current = null;
				setPreparation(null);
				setContext("");
				setSource("");
				const handle = startDefensePreparation(input);
				runId = handle.runId;
				preparationScopeRef.current = {
					vaultPath: input.vaultRoot,
					runId: handle.runId,
				};
				setActivePreparationRunId(handle.runId);
				writePreparationRecovery({
					vaultPath: input.vaultRoot,
					paperPath: input.paperPath,
					runId: handle.runId,
				});
				const completed = await handle.completion;
				if (isCurrentPreparationScope(input.vaultRoot, completed.runId)) {
					setPreparation(completed);
				}
				trackViva("preparation_completed", { partial: completed.partial });
				notifySuccess(t("voiceDefense.preparation.completed"));
				return;
			}
			if (!preparation) return;
			runId = preparation.runId;
			preparationScopeRef.current = {
				vaultPath: input.vaultRoot,
				runId: preparation.runId,
			};
			setActivePreparationRunId(preparation.runId);
			writePreparationRecovery({
				vaultPath: input.vaultRoot,
				paperPath: input.paperPath,
				runId: preparation.runId,
			});
			const completed = await resumeDefensePreparation({
				...input,
				runId: preparation.runId,
			});
			if (isCurrentPreparationScope(input.vaultRoot, completed.runId)) {
				setPreparation(completed);
			}
			trackViva("preparation_completed", { partial: completed.partial });
			notifySuccess(t("voiceDefense.preparation.completed"));
		} catch (error) {
			if (isBackgroundTaskCancelledError(error)) return;
			trackViva("preparation_failed");
			if (runId && isCurrentPreparationScope(input.vaultRoot, runId)) {
				setPreparationError(true);
				if (error instanceof DefensePreparationFailedError) {
					setPreparation(error.manifest);
				}
			}
			notifyError(t("voiceDefense.preparation.failed"), {
				description: preparationFailureDescription(error),
			});
		} finally {
			if (runId) {
				setActivePreparationRunId((current) =>
					current === runId ? null : current,
				);
			}
		}
	};

	const cancelPreparation = async (): Promise<boolean> => {
		const runId = activePreparationRunId ?? preparation?.runId;
		const scope = preparationScopeRef.current;
		if (!runId) return true;
		try {
			await cancelDefensePreparation(runId);
			await waitForPreparationChildrenIdle();
			if (
				vaultPath &&
				preparationScopeRef.current.vaultPath === scope.vaultPath &&
				preparationScopeRef.current.runId === scope.runId
			) {
				const persisted = await loadDefensePreparation(vaultPath, runId);
				setPreparation(
					persisted
						? await refreshDefensePreparation(
								vaultPath,
								runId,
								preparationCurrent,
							)
						: null,
				);
			}
			setPreparation(null);
			setPreparationError(false);
			setPreparationLoading(false);
			setContext("");
			setSource("");
			loadedBriefKeyRef.current = null;
			clearPreparationRecovery(runId);
			return true;
		} catch (error) {
			notifyError(t("voiceDefense.preparation.cancelFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
			return false;
		} finally {
			setActivePreparationRunId((current) =>
				current === runId ? null : current,
			);
		}
	};

	const startVoice = async (
		material: string,
		materialSource: string,
		preparationRunId: string | null,
		operation: number,
	): Promise<boolean> => {
		trackViva("session_start_requested", {
			step: "voice",
			operation,
			open: isDialogOpen(),
			starting: startGateRef.current.isStarting,
		});
		setPhase("connecting");
		const leaseId = startGateRef.current.leaseId;
		if (!leaseId) {
			reportStartFailure("blocked", t("voiceDefense.preparation.startBlocked"));
			setPhase("error");
			return false;
		}
		if (!vaultPath || !material.trim() || !authStatus?.connected) {
			reportStartFailure(
				"unavailable",
				t("voiceDefense.preparation.startUnavailable"),
			);
			setPhase("error");
			return false;
		}
		if (!isTauri()) {
			reportStartFailure(
				"unavailable",
				t("voiceDefense.preparation.startUnavailable"),
			);
			setPhase("error");
			return false;
		}
		if (clientRef.current) {
			reportStartFailure("blocked", t("voiceDefense.preparation.startBlocked"));
			setPhase("error");
			return false;
		}
		setContext(material);
		setSource(materialSource);
		voicePreparationRunIdRef.current = preparationRunId;
		if (preparationRunId) sessionPreparationRunIdRef.current = preparationRunId;
		sessionMaterialsRef.current = [...selectedMaterialPaths];
		setPhase("connecting");
		clearPreparationRecovery(preparationRunId ?? undefined);
		setErrorText("");
		setCaptions([]);
		captionsRef.current = [];
		captionPacerRef.current.reset();
		setStageCaptions([]);
		committeePlaybackRef.current = false;
		setSavedPath(null);
		setEndedAt(null);
		setDebrief(null);
		startedAtRef.current = null;
		setStartedAt(null);
		const markVoiceStarted = (activity: "playback") => {
			const next = nextVoiceSessionStartedAt(
				startedAtRef.current,
				activity,
				new Date(),
			);
			if (next === startedAtRef.current) return;
			startedAtRef.current = next;
			setStartedAt(next);
		};
		const client = new VoiceDefenseClient({
			onStatus: (status) => {
				if (
					clientRef.current !== client ||
					startGateRef.current.leaseId !== leaseId
				) {
					return;
				}
				setConnectionStatus(status);
				if (status === "speaking") {
					captionPacerRef.current.markSpeaking(performance.now());
				} else if (status === "listening") {
					captionPacerRef.current.markIdle(performance.now());
				}
				if (
					status === "listening" ||
					status === "speaking" ||
					status === "live"
				) {
					setPhase("live");
				}
			},
			onCaption: (caption) => {
				if (
					clientRef.current !== client ||
					startGateRef.current.leaseId !== leaseId
				) {
					return;
				}
				captionPacerRef.current.push(caption, performance.now());
				const stagedNow = captionPacerRef.current.tick(performance.now());
				setStageCaptions(stagedNow);
				setCaptions((previous) => {
					const next = upsertVoiceCaption(previous, caption);
					captionsRef.current = next;
					return next;
				});
			},
			onRemoteStream: (stream) => {
				if (
					clientRef.current !== client ||
					startGateRef.current.leaseId !== leaseId
				) {
					return;
				}
				if (!audioRef.current) return;
				audioRef.current.srcObject = stream;
				audioRef.current.muted = !committeePlaybackRef.current;
				void audioRef.current.play().catch(() => undefined);
			},
			onCommitteePlayback: (enabled) => {
				if (
					clientRef.current !== client ||
					startGateRef.current.leaseId !== leaseId
				) {
					return;
				}
				committeePlaybackRef.current = enabled;
				if (enabled) markVoiceStarted("playback");
				if (audioRef.current) audioRef.current.muted = !enabled;
			},
			onError: (error) => {
				if (
					clientRef.current !== client ||
					startGateRef.current.leaseId !== leaseId
				) {
					return;
				}
				const code = voiceDefenseErrorCode(error);
				setErrorText(code ? t(`voiceDefense.error.${code}`) : error.message);
				setPhase("error");
				if (clientRef.current === client) clientRef.current = null;
				void client.close().finally(() => {
					releaseOwnedVoiceSession(leaseId);
				});
			},
		});
		clientRef.current = client;
		startGateRef.current.markConnected();
		setVoiceStarting(false);
		try {
			await client.connect(
				buildDefenseBootstrap({
					title: defenseTitle,
					source: materialSource,
					context: material,
					language: defenseLanguage,
					scenario,
					plannedMinutes,
					difficulty,
				}),
				{ language: defenseLanguage },
			);
			trackViva("session_connected", { scenario, plannedMinutes });
			return true;
		} catch (error) {
			const code = voiceDefenseErrorCode(error);
			const message = code
				? t(`voiceDefense.error.${code}`)
				: error instanceof Error
					? error.message
					: String(error);
			await client.close().catch(() => undefined);
			if (clientRef.current === client) clientRef.current = null;
			releaseOwnedVoiceSession(leaseId);
			if (message === "Voice connection cancelled") {
				return false;
			}
			setErrorText(message);
			setPhase("error");
			notifyError(t("voiceDefense.startFailed"), { description: message });
			return false;
		}
	};

	/** Load the prepared challenge outline used by the post-session debrief. */
	const loadReviewQuestions = async (
		vaultRoot: string,
		manifest: DefensePreparationManifest,
	): Promise<void> => {
		try {
			const artifactPath = manifest.nodes["adversarial-review"].artifactPath;
			if (!artifactPath) {
				reviewQuestionsRef.current = [];
				return;
			}
			const artifact = await loadDefenseArtifact(
				createVaultPreparationStorage(vaultRoot),
				artifactPath,
			);
			reviewQuestionsRef.current =
				artifact?.payload?.kind === "review" ? artifact.payload.questions : [];
		} catch {
			// The debrief is an enhancement; a missing outline must never block
			// the session itself.
			reviewQuestionsRef.current = [];
		}
	};

	const materialsMatchSnapshot = useMemo(() => {
		if (!preparation) return true;
		const snapshotPaths = preparation.snapshot.materials
			.map((material) => material.path)
			.sort();
		const selectedPaths = [...selectedMaterialPaths].sort();
		if (snapshotPaths.length !== selectedPaths.length) return false;
		return snapshotPaths.every((path, index) => path === selectedPaths[index]);
	}, [preparation, selectedMaterialPaths]);

	const startWithPreparedMaterial = async () => {
		setStartError("");
		trackViva("session_start_requested", {
			ready: Boolean(preparation),
			connected: Boolean(authStatus?.connected),
			path: "immediate",
		});
		const plan = planPreparedDefenseEnter({
			vaultPath,
			preparation,
			context,
			materialsMatchSnapshot,
		});
		if (plan.action === "reject") {
			reportStartFailure(
				plan.reason,
				plan.reason === "stale"
					? t("voiceDefense.preparation.staleNotice")
					: plan.reason === "selection_changed"
						? t("voiceDefense.preparation.selectionChangedNotice")
						: t("voiceDefense.preparation.startUnavailable"),
			);
			return;
		}
		if (!vaultPath) {
			reportStartFailure(
				"unavailable",
				t("voiceDefense.preparation.startUnavailable"),
			);
			return;
		}
		setPhase(preparedDefenseEnterPhase(plan));
		trackViva("session_start_requested", { step: "connecting" });
		const runId = plan.runId;
		const vaultRoot = vaultPath;
		preparationScopeRef.current = { vaultPath: vaultRoot, runId };
		let operation: number | null = null;
		let started = false;
		const connectingWatchdog = window.setTimeout(() => {
			if (phaseRef.current !== "connecting") return;
			const client = clientRef.current;
			if (clientRef.current === client) clientRef.current = null;
			void client?.close().catch(() => undefined);
			invalidateVoiceStart();
			setPhase("error");
			reportStartFailure("timeout", t("voiceDefense.preparation.startTimeout"));
		}, 45_000);
		try {
			operation = beginVoiceStart({ takeoverStaleLease: true });
			trackViva("session_start_requested", {
				step: "lease",
				operation: operation ?? 0,
				blocked: operation === null,
			});
			if (operation === null) {
				setPhase("error");
				reportStartFailure(
					"blocked",
					t("voiceDefense.preparation.startBlocked"),
				);
				return;
			}
			const leaseOperation = operation;
			started = await runPreparedDefenseEnter({
				connect: () =>
					startVoice(plan.material, plan.source, runId, leaseOperation),
				confirm: () => {
					void confirmDefensePreparation(vaultRoot, runId, plan.material, {
						skipSnapshotFreshness: true,
						force: true,
					})
						.then((confirmed) => {
							if (confirmed.runId !== runId) return;
							setPreparation(confirmed);
							void refreshTreeQuiet(vaultRoot);
							void loadReviewQuestions(vaultRoot, confirmed);
						})
						.catch((error) => {
							trackViva("session_start_failed", {
								reason: "confirm_background",
								message: error instanceof Error ? error.message : String(error),
							});
						});
				},
			});
		} catch (error) {
			setPhase("error");
			reportStartFailure(
				"start_threw",
				error instanceof Error ? error.message : String(error),
			);
		} finally {
			window.clearTimeout(connectingWatchdog);
			if (operation !== null && !started) releaseVoiceStart(operation);
		}
	};

	// "Run it again" from the debrief: same brief, fresh session, no
	// re-confirmation (the completed preparation record stays untouched).
	const restartDefense = async () => {
		if (!context.trim()) return;
		await cancelDefenseReview();
		setReview(null);
		setReviewPath(null);
		setReviewing(false);
		const operation = beginVoiceStart();
		if (operation === null) return;
		let started = false;
		try {
			started = await startVoice(context, source, null, operation);
		} finally {
			if (!started) releaseVoiceStart(operation);
		}
	};

	/**
	 * Close the realtime session and land on the debrief. The transcript stays
	 * in memory only: it is written to the Vault exclusively through
	 * `saveTranscript`, when the user explicitly asks for it.
	 */
	const endSession = useCallback(async () => {
		if (finishingRef.current !== null) return;
		const finishOperation = startGateRef.current.currentOperation;
		finishingRef.current = finishOperation;
		const isCurrentFinish = () =>
			finishingRef.current === finishOperation &&
			startGateRef.current.currentOperation === finishOperation;
		const finishDebrief = () => {
			const composed =
				reviewQuestionsRef.current.length > 0
					? buildDefenseDebrief(captionsRef.current, reviewQuestionsRef.current)
					: null;
			setDebrief(composed);
			const startedAtValue = startedAtRef.current;
			trackViva("session_ended", {
				durationSeconds: startedAtValue
					? Math.max(
							0,
							Math.round((Date.now() - startedAtValue.getTime()) / 1000),
						)
					: null,
				captions: captionsRef.current.length,
				covered: composed
					? `${composed.askedCount}/${composed.totalCount}`
					: null,
			});
		};
		setPhase("ending");
		const client = clientRef.current;
		const leaseId = startGateRef.current.leaseId;
		const preparationRunId = voicePreparationRunIdRef.current;
		try {
			try {
				await client?.close();
			} finally {
				if (clientRef.current === client) clientRef.current = null;
				releaseOwnedVoiceSession(leaseId);
			}
			if (vaultPath && preparationRunId) {
				try {
					const completed = await completeDefensePreparation(
						vaultPath,
						preparationRunId,
					);
					if (isCurrentFinish()) setPreparation(completed);
					if (voicePreparationRunIdRef.current === preparationRunId) {
						voicePreparationRunIdRef.current = null;
					}
				} catch (error) {
					notifyError(t("voiceDefense.preparation.completeFailed"), {
						description: error instanceof Error ? error.message : String(error),
					});
				}
			}
			if (!isCurrentFinish()) return;
			finishDebrief();
			setEndedAt(new Date());
			setPhase("ended");
		} catch (error) {
			// Closing the transport failed; the captions are still in memory, so
			// the debrief (with its save action) remains the right destination.
			if (!isCurrentFinish()) return;
			notifyError(t("voiceDefense.endFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
			finishDebrief();
			setEndedAt(new Date());
			setPhase("ended");
		} finally {
			if (finishingRef.current === finishOperation) {
				finishingRef.current = null;
			}
		}
	}, [releaseOwnedVoiceSession, t, vaultPath]);

	/** Explicit user action from the debrief: write the transcript to the Vault. */
	const saveTranscript = useCallback(async (): Promise<string | null> => {
		const startedAtValue = startedAtRef.current;
		if (!vaultPath || !startedAtValue || savedPath || savingTranscript)
			return savedPath;
		setSavingTranscript(true);
		try {
			const relative = await availableTranscriptPath(vaultPath, startedAtValue);
			const duration =
				endedAt !== null
					? Math.max(
							0,
							Math.round((endedAt.getTime() - startedAtValue.getTime()) / 1000),
						)
					: Math.max(
							0,
							Math.round((Date.now() - startedAtValue.getTime()) / 1000),
						);
			const markdown = buildVoiceTranscriptMarkdown({
				title: defenseTitle,
				source,
				context,
				startedAt: startedAtValue,
				captions: [...captionsRef.current],
				language: defenseLanguage,
				debrief,
				durationSeconds: duration,
				materials:
					sessionMaterialsRef.current.length > 0
						? sessionMaterialsRef.current
						: selectedMaterialPaths,
				preparationRun: sessionPreparationRunIdRef.current ?? undefined,
				scenario,
			});
			await writeVaultFile(joinVaultPath(vaultPath, relative), markdown);
			await refreshTreeQuiet(vaultPath);
			setSavedPath(relative);
			trackViva("transcript_saved", {
				withDebrief: Boolean(debrief && debrief.totalCount > 0),
			});
			notifySuccess(t("voiceDefense.saved", { path: relative }));
			return relative;
		} catch (error) {
			notifyError(t("voiceDefense.saveFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
			return null;
		} finally {
			setSavingTranscript(false);
		}
	}, [
		context,
		debrief,
		defenseLanguage,
		defenseTitle,
		endedAt,
		savedPath,
		savingTranscript,
		scenario,
		selectedMaterialPaths,
		source,
		t,
		vaultPath,
	]);

	const generateReview = useCallback(async () => {
		if (
			!vaultPath ||
			reviewing ||
			isDefenseReviewActive() ||
			captionsRef.current.length === 0
		) {
			return;
		}
		setReviewing(true);
		try {
			const transcriptPath = savedPath ?? (await saveTranscript());
			if (!transcriptPath) return;
			const allowedSourcePaths =
				preparation?.snapshot.sources.map((item) => item.path) ??
				selectedMaterialPaths;
			const result = await startDefenseReview({
				vaultRoot: vaultPath,
				title: defenseTitle,
				transcriptPath,
				brief: context,
				briefPath: source || undefined,
				captions: [...captionsRef.current],
				questions: reviewQuestionsRef.current,
				debrief,
				allowedSourcePaths,
				language: defenseLanguage,
				agentId: selectedAgentId,
				modelId,
				reasoningEffort,
			});
			setReview(result.review);
			setReviewPath(result.reviewPath);
			await refreshTreeQuiet(vaultPath);
			notifySuccess(
				t("voiceDefense.ended.evaluateDone", { path: result.reviewPath }),
			);
		} catch (error) {
			notifyError(t("voiceDefense.ended.evaluateFailed"), {
				description: error instanceof Error ? error.message : String(error),
			});
		} finally {
			setReviewing(false);
		}
	}, [
		context,
		debrief,
		defenseLanguage,
		defenseTitle,
		modelId,
		preparation,
		reasoningEffort,
		reviewing,
		saveTranscript,
		savedPath,
		selectedAgentId,
		selectedMaterialPaths,
		source,
		t,
		vaultPath,
	]);

	useEffect(() => {
		if (phase !== "live" && phase !== "connecting") return;
		const tick = () => {
			setStageCaptions(captionPacerRef.current.tick(performance.now()));
		};
		tick();
		const timer = window.setInterval(tick, 80);
		return () => window.clearInterval(timer);
	}, [phase]);

	const handleOpenChange = (next: boolean) => {
		if (next) {
			openRef.current = true;
			setOpen(true);
			return;
		}
		if (preparationActive) reopenBackgroundPreparationRef.current = true;
		clearPreparationRecovery(preparation?.runId ?? recoveryRunId ?? undefined);
		invalidateVoiceStart();
		// Only a session that has actually played committee audio needs a
		// debrief handoff. Opening-gate captions can arrive before playback and
		// must still let the user close the window immediately after an error.
		if (shouldHandoffVoiceSession(phase, startedAtRef.current)) {
			openRef.current = true;
			void endSession();
			return;
		}
		if (phase === "connecting" || phase === "error") {
			const client = clientRef.current;
			const leaseId = startGateRef.current.leaseId;
			if (clientRef.current === client) clientRef.current = null;
			if (client) {
				void client.close().finally(() => {
					releaseOwnedVoiceSession(leaseId);
				});
			} else {
				releaseOwnedVoiceSession(leaseId);
			}
		}
		if (windowMode) {
			closingNativeRef.current = true;
			void closeCurrentVivaWindow().then((closed) => {
				if (closed) {
					openRef.current = false;
					return;
				}
				closingNativeRef.current = false;
				openRef.current = true;
			});
			return;
		}
		openRef.current = false;
		setOpen(false);
	};
	const handleOpenChangeRef = useRef(handleOpenChange);
	handleOpenChangeRef.current = handleOpenChange;

	useEffect(() => {
		if (!windowMode || !isTauri()) return;
		let unlisten: (() => void) | undefined;
		let cancelled = false;
		void (async () => {
			try {
				const { getCurrentWindow } = await import("@tauri-apps/api/window");
				const dispose = await getCurrentWindow().onCloseRequested((event) => {
					if (closingNativeRef.current) return;
					const needsSessionHandoff = shouldHandoffVoiceSession(
						phaseRef.current,
						startedAtRef.current,
					);
					if (!needsSessionHandoff) return;
					event.preventDefault();
					handleOpenChangeRef.current(false);
				});
				if (cancelled) dispose();
				else unlisten = dispose;
			} catch {
				// Older webviews without CloseRequested still close via the in-UI button.
			}
		})();
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, [windowMode]);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape" && !event.defaultPrevented) {
				handleOpenChangeRef.current(false);
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [open]);

	const toggleMuted = () => {
		const next = !muted;
		setMuted(next);
		clientRef.current?.setMuted(next);
	};

	const selectPlannedMinutes = (minutes: number | null) => {
		const next = minutes === null ? null : clampPlannedDurationMinutes(minutes);
		setPlannedMinutes(next);
		writePlannedDurationMinutes(next);
	};

	const selectScenario = (next: VoiceScenario) => {
		setScenario(next);
		writeStoredScenario(next);
	};

	const selectDefenseLanguage = (next: "en" | "zh-CN") => {
		setDefenseLanguage(next);
		writeStoredLanguage(next);
	};

	const selectDifficulty = (next: VoiceDifficulty) => {
		setDifficulty(next);
		writeStoredDifficulty(next);
	};

	const useReusablePreparation = () => {
		if (!reusableManifest) return;
		preparationScopeRef.current = {
			vaultPath,
			runId: reusableManifest.runId,
		};
		setPreparationError(false);
		setPreparation(reusableManifest);
		setSelectedMaterialPaths(
			reusableManifest.snapshot.materials.map((material) => material.path),
		);
		setInstruction(reusableManifest.snapshot.instruction);
	};

	const sendLivePatch = (text: string): boolean => {
		const ok =
			clientRef.current?.sendUserText(
				buildDefenseContextPatch(text, defenseLanguage),
			) ?? false;
		if (!ok) notifyError(t("voiceDefense.patch.blocked"));
		else notifySuccess(t("voiceDefense.patch.sent"));
		return ok;
	};

	const sendLiveRefocus = (): boolean => {
		const ok =
			clientRef.current?.sendUserText(
				buildDefenseRefocusPrompt(defenseLanguage),
			) ?? false;
		if (!ok) notifyError(t("voiceDefense.patch.blocked"));
		else notifySuccess(t("voiceDefense.refocusSent"));
		return ok;
	};

	const interrupt = () => {
		clientRef.current?.interrupt();
	};

	const handleTimeUp = useCallback(() => {
		notifySuccess(t("voiceDefense.stage.timeUp"), {
			description: t("voiceDefense.stage.timeUpHint"),
		});
	}, [t]);

	const connectAccount = async () => {
		if (startGateRef.current.isStarting) return;
		setAuthBusy(true);
		try {
			setAuthStatus(await connectVoiceAuth(t("voiceDefense.auth.windowTitle")));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notifyError(t("voiceDefense.auth.connectFailed"), {
				description: describeVoiceAuthError(
					message,
					t("voiceDefense.auth.credentialOwnerConflict"),
				),
			});
			setAuthBusy(false);
		}
	};

	const cancelAccountConnection = async () => {
		if (startGateRef.current.isStarting) return;
		setAuthBusy(true);
		try {
			setAuthStatus(await cancelVoiceAuth());
		} finally {
			setAuthBusy(false);
		}
	};

	const disconnectAccount = async () => {
		if (startGateRef.current.isStarting) return;
		setAuthBusy(true);
		try {
			setAuthStatus(await disconnectVoiceAuth());
			notifySuccess(t("voiceDefense.auth.disconnected"));
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			notifyError(t("voiceDefense.auth.disconnectFailed"), {
				description: describeVoiceAuthError(
					message,
					t("voiceDefense.auth.credentialOwnerConflict"),
				),
			});
		} finally {
			setAuthBusy(false);
		}
	};

	const preparationActive = Boolean(activePreparationRunId);
	const preparationInterrupted = Boolean(
		preparation &&
			RUNNING_PREPARATION_STATUSES.has(preparation.status) &&
			!preparationActive,
	);
	const preparationFailed = Boolean(
		preparationError ||
			(preparation &&
				(preparation.status === "failed" ||
					preparation.status === "cancelled" ||
					preparationInterrupted)),
	);
	const preparationReady = Boolean(
		preparation &&
			(preparation.status === "awaiting_review" ||
				preparation.status === "ready" ||
				preparation.status === "completed"),
	);
	// Only lock material/instruction edits while a run is in flight — after a
	// run finishes the user can change the optional material set and re-prepare.
	const preparationInputsLocked = preparationActive;
	const selectionChanged = Boolean(preparation) && !materialsMatchSnapshot;
	const toggleMaterial = (path: string) => {
		if (preparationInputsLocked || voiceStarting) return;
		setSelectedMaterialPaths((current) =>
			current.includes(path)
				? current.filter((item) => item !== path)
				: [...current, path],
		);
	};
	const preparationStatusLabel = preparationError
		? t("voiceDefense.preparation.failedStatus")
		: selectionChanged
			? t("voiceDefense.preparation.selectionChanged")
			: preparation?.stale
				? t("voiceDefense.preparation.stale")
				: preparationActive
					? t("voiceDefense.preparation.running")
					: preparationInterrupted
						? t("voiceDefense.preparation.interrupted")
						: preparation?.status === "failed"
							? t("voiceDefense.preparation.failedStatus")
							: preparation?.status === "cancelled"
								? t("voiceDefense.preparation.cancelled")
								: preparationReady
									? t("voiceDefense.preparation.ready")
									: t("voiceDefense.preparation.notPrepared");

	const durationSeconds =
		startedAt && endedAt
			? Math.max(
					0,
					Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
				)
			: null;
	const questionCount = captions.filter(
		(caption) => caption.role === "assistant",
	).length;

	return {
		open,
		phase,
		windowMode,
		t,
		audioRef,
		displayTitle,
		defenseTitle,
		authStatus,
		authBusy,
		connectAccount,
		cancelAccountConnection,
		disconnectAccount,
		selectedMaterials,
		filteredMaterialOptions,
		focusedMaterialPath,
		selectedMaterialPaths,
		materialSearch,
		setMaterialSearch,
		toggleMaterial,
		preparationInputsLocked,
		instruction,
		setInstruction,
		plannedMinutes,
		selectPlannedMinutes,
		scenario,
		selectScenario,
		defenseLanguage,
		selectDefenseLanguage,
		difficulty,
		selectDifficulty,
		reusableManifest,
		useReusablePreparation,
		history,
		onOpenSource,
		preparation,
		preparationActive,
		preparationLoading,
		preparationStatusLabel,
		preparationReady,
		preparationFailed,
		selectionChanged,
		voiceStarting,
		startError,
		context,
		setContext,
		source,
		runPreparation,
		cancelPreparation,
		startWithPreparedMaterial,
		durationSeconds,
		questionCount,
		captions,
		stageCaptions,
		debrief,
		review,
		reviewPath,
		reviewing,
		savedPath,
		savingTranscript,
		saveTranscript,
		generateReview,
		restartDefense,
		handleOpenChange,
		connectionStatus,
		muted,
		errorText,
		startedAt,
		handleTimeUp,
		toggleMuted,
		interrupt,
		sendLivePatch,
		sendLiveRefocus,
		endSession,
		retryPrepare: () => setPhase("prepare"),
		vaultPath,
	};
}
