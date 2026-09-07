/**
 * Agent registry + per-agent configuration: models / collaboration modes /
 * reasoning effort / fast mode / usage, ACP warm prefetch, and the picker
 * actions. Emits the apply* handlers consumed by the session-runtime
 * listeners.
 */
import {
	type Dispatch,
	type SetStateAction,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type {
	AgentPanelRefs,
	AgentPanelT,
} from "@/components/agent/hooks/use-agent-panel-context";
import {
	type AgentEffortChoice,
	type AgentListResponse,
	type AgentModeChoice,
	type AgentModelChoice,
	type AgentSkill,
	type CatalogScanResponse,
	listAgentSkills,
	listAgents,
	loadCollaborationPref,
	loadModelCatalog,
	loadModelFavorites,
	loadModelPref,
	loadReasoningEffortPref,
	resolveReasoningEffort,
	saveCollaborationPref,
	saveModelCatalog,
	saveModelFavorites,
	saveModelPref,
	saveReasoningEffortPref,
	scanCatalog,
	warmAgent,
} from "@/lib/agent";
import {
	type ChatLine,
	dedupeModelsClient,
	ensureModelsInclude,
	errorChatLine,
	errorText,
} from "@/lib/agent/chat-state";
import type { AcpCommand } from "@/lib/agent/slash-commands";
import { isTauri } from "@/lib/core/tauri";
import { lifecycle } from "@/lib/lifecycle";

/**
 * Debounce before the Chat-open / agent-switch warm spawns its ACP process.
 * `warm_agent` has no cancellation path, so every superseded spawn would run
 * to completion as an orphan; settling the switch first avoids that (Fix #274).
 */
const WARM_SPAWN_DEBOUNCE_MS = 300;

/** Model picker grouping produced by `groupedModels` below. */
export type GroupedModel = {
	id: string;
	heading: string;
	isFavorites: boolean;
	items: AgentModelChoice[];
};

export type UseAgentConfigOptions = {
	vaultPath: string | null;
	selectedAgentId: string | null;
	setSelectedAgentId: Dispatch<SetStateAction<string | null>>;
	refs: Pick<
		AgentPanelRefs,
		"historyHydrationGenRef" | "selectedAgentIdRef" | "vaultPathRef"
	>;
	t: AgentPanelT;
	setLines: (update: ChatLine[] | ((prev: ChatLine[]) => ChatLine[])) => void;
};

export type AgentConfig = {
	registry: AgentListResponse | null;
	catalog: CatalogScanResponse | null;
	skills: AgentSkill[];
	models: AgentModelChoice[];
	modelId: string | null;
	favoriteIds: string[];
	modelSelectorOpen: boolean;
	setModelSelectorOpen: Dispatch<SetStateAction<boolean>>;
	warming: boolean;
	agentListenersReady: boolean;
	setAgentListenersReady: Dispatch<SetStateAction<boolean>>;
	usage: { used: number; size: number } | null;
	setUsage: Dispatch<SetStateAction<{ used: number; size: number } | null>>;
	usageBySession: Record<string, { used: number; size: number }>;
	setUsageBySession: Dispatch<
		SetStateAction<Record<string, { used: number; size: number }>>
	>;
	acpCommandsByAgent: Record<string, AcpCommand[]>;
	setAcpCommandsByAgent: Dispatch<SetStateAction<Record<string, AcpCommand[]>>>;
	collaborationOptions: AgentModeChoice[];
	collaborationModeId: string | null;
	effortOptions: AgentEffortChoice[];
	reasoningEffort: string | null;
	pickReasoningEffort: (id: string) => void;
	fastAvailable: boolean;
	fastEnabled: boolean;
	setFastEnabled: Dispatch<SetStateAction<boolean>>;
	applyModelsEvent: (ev: {
		agentId: string;
		configId: string;
		currentId: string;
		models: AgentModelChoice[];
	}) => void;
	applyCollaborationEvent: (ev: {
		agentId: string;
		currentId: string;
		modes: AgentModeChoice[];
	}) => void;
	applyEffortEvent: (ev: {
		agentId: string;
		currentId: string;
		efforts: AgentEffortChoice[];
	}) => void;
	applyFastModeEvent: (ev: { agentId: string; enabled: boolean }) => void;
	refresh: () => Promise<void>;
	selectedModelName: string | null;
	groupedModels: {
		id: string;
		heading: string;
		isFavorites: boolean;
		items: AgentModelChoice[];
	}[];
	selectedCollaborationName: string | null;
	pickCollaborationMode: (id: string) => void;
	pickModel: (id: string) => void;
	toggleFavorite: (id: string) => void;
};

export function useAgentConfig({
	vaultPath,
	selectedAgentId,
	setSelectedAgentId,
	refs: { historyHydrationGenRef, selectedAgentIdRef, vaultPathRef },
	t,
	setLines,
}: UseAgentConfigOptions): AgentConfig {
	const [registry, setRegistry] = useState<AgentListResponse | null>(null);
	const [catalog, setCatalog] = useState<CatalogScanResponse | null>(null);
	const [skills, setSkills] = useState<AgentSkill[]>([]);
	const [usage, setUsage] = useState<{ used: number; size: number } | null>(
		null,
	);
	const [usageBySession, setUsageBySession] = useState<
		Record<string, { used: number; size: number }>
	>({});
	const [acpCommandsByAgent, setAcpCommandsByAgent] = useState<
		Record<string, AcpCommand[]>
	>({});
	const [models, setModels] = useState<AgentModelChoice[]>([]);
	const [modelId, setModelId] = useState<string | null>(null);
	const [favoriteIds, setFavoriteIds] = useState<string[]>([]);
	const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
	const [warming, setWarming] = useState(false);
	const [agentListenersReady, setAgentListenersReady] = useState(false);
	const [collaborationOptions, setCollaborationOptions] = useState<
		AgentModeChoice[]
	>([]);
	const [collaborationModeId, setCollaborationModeId] = useState<string | null>(
		null,
	);
	const [effortOptions, setEffortOptions] = useState<AgentEffortChoice[]>([]);
	const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
	const [fastAvailable, setFastAvailable] = useState(false);
	const [fastEnabled, setFastEnabled] = useState(false);
	const warmGenRef = useRef(0);

	const applyModelsEvent = useCallback(
		(ev: {
			agentId: string;
			configId: string;
			currentId: string;
			models: AgentModelChoice[];
		}) => {
			const cur = selectedAgentIdRef.current;
			const pref = loadModelPref(ev.agentId)?.trim() || null;
			const current = ev.currentId?.trim() || null;
			// Keep user/custom prefs and agent current even when not in the fixed
			// official catalog (third-party / gateway model ids; Fix #216).
			const catalogModels = ensureModelsInclude(dedupeModelsClient(ev.models), [
				current,
				pref,
			]);
			if (catalogModels.length === 0) return;
			saveModelCatalog(ev.agentId, {
				configId: ev.configId,
				currentId: ev.currentId,
				models: catalogModels,
			});
			if (cur && cur !== ev.agentId) return;
			setModelId((prev) => {
				const prevId = prev?.trim() || null;
				const next = pref || prevId || current || catalogModels[0]?.id || null;
				// Nested setState: keep free-form selection visible in the picker.
				setModels(ensureModelsInclude(catalogModels, [next, prevId]));
				return next;
			});
		},
		[selectedAgentIdRef],
	);

	const applyCollaborationEvent = useCallback(
		(ev: { agentId: string; currentId: string; modes: AgentModeChoice[] }) => {
			const cur = selectedAgentIdRef.current;
			if (cur && cur !== ev.agentId) return;
			if (!ev.modes.length) {
				setCollaborationOptions([]);
				setCollaborationModeId(null);
				return;
			}
			const pref = loadCollaborationPref(ev.agentId)?.trim() || null;
			const current = ev.currentId?.trim() || null;
			const validPref =
				pref && ev.modes.some((mode) => mode.id === pref) ? pref : null;
			setCollaborationOptions(ev.modes);
			setCollaborationModeId((prev) => {
				const prevId = prev?.trim() || null;
				if (prevId && ev.modes.some((mode) => mode.id === prevId)) {
					return prevId;
				}
				return validPref || current || ev.modes[0]?.id || null;
			});
		},
		[selectedAgentIdRef],
	);

	const applyEffortEvent = useCallback(
		(ev: {
			agentId: string;
			currentId: string;
			efforts: AgentEffortChoice[];
		}) => {
			const cur = selectedAgentIdRef.current;
			if (cur && cur !== ev.agentId) return;
			setEffortOptions(ev.efforts);
			setReasoningEffort(
				resolveReasoningEffort(
					loadReasoningEffortPref(ev.agentId),
					ev.currentId,
					ev.efforts,
				),
			);
		},
		[selectedAgentIdRef],
	);

	const applyFastModeEvent = useCallback(
		(ev: { agentId: string; enabled: boolean }) => {
			const cur = selectedAgentIdRef.current;
			if (cur && cur !== ev.agentId) return;
			setFastAvailable(true);
			setFastEnabled(ev.enabled);
		},
		[selectedAgentIdRef],
	);

	const refresh = useCallback(async () => {
		if (!isTauri()) return;
		try {
			const [list, scan, discoveredSkills] = await Promise.all([
				listAgents(),
				scanCatalog(),
				listAgentSkills(vaultPath ?? undefined).catch(() => []),
			]);
			setRegistry(list);
			setCatalog(scan);
			setSkills(discoveredSkills);
			setSelectedAgentId((prev) => prev ?? list.defaultId);
		} catch (e) {
			setLines((prev) => [...prev, errorChatLine(errorText(e))]);
		}
	}, [vaultPath, setLines, setSelectedAgentId]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	// Settings probes/installs/removes agents while this panel stays mounted;
	// refresh on the lifecycle broadcast instead of serving a stale switcher list.
	useEffect(() => {
		let timer: number | undefined;
		const off = lifecycle.on("agent:registry-changed", () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(() => {
				void refresh();
			}, 150);
		});
		return () => {
			window.clearTimeout(timer);
			off();
		};
	}, [refresh]);

	// Restore last model catalog / preference for the selected agent.
	useEffect(() => {
		selectedAgentIdRef.current = selectedAgentId;
		historyHydrationGenRef.current += 1;
		if (!selectedAgentId) {
			setModels([]);
			setModelId(null);
			setFavoriteIds([]);
			setCollaborationOptions([]);
			setCollaborationModeId(null);
			setEffortOptions([]);
			setReasoningEffort(null);
			setFastAvailable(false);
			setFastEnabled(false);
			setUsage(null);
			setUsageBySession({});
			return;
		}
		setCollaborationOptions([]);
		setCollaborationModeId(loadCollaborationPref(selectedAgentId));
		setEffortOptions([]);
		setReasoningEffort(loadReasoningEffortPref(selectedAgentId));
		setFastAvailable(false);
		setFastEnabled(false);
		setUsage(null);
		setUsageBySession({});
		setFavoriteIds(loadModelFavorites(selectedAgentId));
		const catalog = loadModelCatalog(selectedAgentId);
		const pref = loadModelPref(selectedAgentId);
		if (catalog?.models.length) {
			const preferred =
				(pref?.trim() ? pref.trim() : null) ||
				(catalog.currentId?.trim() ? catalog.currentId.trim() : null) ||
				catalog.models[0]?.id ||
				null;
			const models = ensureModelsInclude(dedupeModelsClient(catalog.models), [
				preferred,
				catalog.currentId,
				pref,
			]);
			setModels(models);
			setModelId(preferred);
		} else {
			const models = ensureModelsInclude([], [pref]);
			setModels(models);
			setModelId(pref?.trim() ? pref.trim() : null);
		}
	}, [selectedAgentId, historyHydrationGenRef, selectedAgentIdRef]);

	/**
	 * Shared ACP warm: prefetch models / usage. Used on Chat open and model switch.
	 * `stillValid` gates applying results after racey agent/vault/model changes.
	 */
	const runWarmAgent = useCallback(
		async (args: {
			agentId: string;
			vaultPath: string | null;
			modelId?: string;
			collaborationModeId?: string;
			generation: number;
			/** Apply models/usage only when still the intended warm target. */
			stillValid: () => boolean;
			/**
			 * Clear the warming spinner when this generation is still current.
			 * Defaults to `stillValid`; model-switch uses a looser check so a
			 * superseded model pref does not leave the spinner stuck.
			 */
			stillWarming?: () => boolean;
		}) => {
			setWarming(true);
			try {
				const result = await warmAgent({
					agentId: args.agentId,
					vaultPath: args.vaultPath ?? undefined,
					modelId: args.modelId,
					collaborationModeId: args.collaborationModeId,
				});
				if (args.generation !== warmGenRef.current || !args.stillValid()) {
					return;
				}
				if (result.models) applyModelsEvent(result.models);
				if (
					result.usageUsed != null &&
					result.usageSize != null &&
					result.usageSize > 0
				) {
					setUsage({ used: result.usageUsed, size: result.usageSize });
				}
			} catch {
				// Warm is best-effort; first message can still discover models.
			} finally {
				const keepWarmingCheck = args.stillWarming ?? args.stillValid;
				if (args.generation === warmGenRef.current && keepWarmingCheck()) {
					setWarming(false);
				}
			}
		},
		[applyModelsEvent],
	);

	// When Chat opens (or agent/vault changes), warm ACP in the background for models/context.
	useEffect(() => {
		if (!isTauri() || !selectedAgentId || !agentListenersReady) return;
		// Supersede any in-flight warm immediately (its results are dropped)…
		const gen = ++warmGenRef.current;
		let cancelled = false;
		// …but debounce the spawn itself: warm_agent cannot be cancelled, so a
		// rapid agent/vault switch must not start one ACP process per change.
		const timer = setTimeout(() => {
			const agentId = selectedAgentId;
			const requestVaultPath = vaultPath;
			void runWarmAgent({
				agentId,
				vaultPath: requestVaultPath,
				modelId: loadModelPref(agentId) ?? undefined,
				collaborationModeId: loadCollaborationPref(agentId) ?? undefined,
				generation: gen,
				stillValid: () =>
					!cancelled &&
					selectedAgentIdRef.current === agentId &&
					vaultPathRef.current === requestVaultPath,
			});
		}, WARM_SPAWN_DEBOUNCE_MS);
		return () => {
			cancelled = true;
			clearTimeout(timer);
		};
	}, [
		selectedAgentId,
		vaultPath,
		runWarmAgent,
		agentListenersReady,
		selectedAgentIdRef,
		vaultPathRef,
	]);

	const selectedModelName = useMemo(() => {
		if (!modelId) return null;
		return models.find((m) => m.id === modelId)?.name ?? modelId;
	}, [modelId, models]);

	const groupedModels = useMemo(() => {
		const favItems = favoriteIds
			.map((id) => models.find((m) => m.id === id))
			.filter((m): m is AgentModelChoice => Boolean(m));

		const groups = new Map<string, AgentModelChoice[]>();
		for (const model of models) {
			const group = model.group || t("models.defaultGroup");
			let items = groups.get(group);
			if (!items) {
				items = [];
				groups.set(group, items);
			}
			items.push(model);
		}

		const result: GroupedModel[] = [];
		if (favItems.length > 0) {
			result.push({
				id: "__favorites__",
				heading: t("models.favorites"),
				isFavorites: true,
				items: favItems,
			});
		}
		for (const [heading, items] of groups) {
			result.push({ id: heading, heading, isFavorites: false, items });
		}
		return result;
	}, [models, favoriteIds, t]);

	const selectedCollaborationName = useMemo(() => {
		if (!collaborationModeId) return null;
		return (
			collaborationOptions.find((mode) => mode.id === collaborationModeId)
				?.name ?? collaborationModeId
		);
	}, [collaborationModeId, collaborationOptions]);

	const pickCollaborationMode = useCallback(
		(id: string) => {
			const next = id.trim();
			if (!next || !collaborationOptions.some((mode) => mode.id === next))
				return;
			setCollaborationModeId(next);
			if (!selectedAgentId) return;
			saveCollaborationPref(selectedAgentId, next);
		},
		[collaborationOptions, selectedAgentId],
	);

	const pickModel = (id: string) => {
		const next = id.trim();
		if (!next) return;
		if (next === modelId) return;
		// Free-form / third-party ids may not be in the advertised catalog yet.
		setModels((prev) => ensureModelsInclude(prev, [next]));
		setModelId(next);
		if (!selectedAgentId) return;
		saveModelPref(selectedAgentId, next);
		if (!isTauri() || !agentListenersReady) return;

		const agentId = selectedAgentId;
		const requestVaultPath = vaultPath;
		const generation = ++warmGenRef.current;
		setEffortOptions([]);
		setReasoningEffort(loadReasoningEffortPref(agentId));
		setFastAvailable(false);
		setFastEnabled(false);
		void runWarmAgent({
			agentId,
			vaultPath: requestVaultPath,
			modelId: next,
			collaborationModeId:
				loadCollaborationPref(agentId) ?? collaborationModeId ?? undefined,
			generation,
			stillValid: () =>
				selectedAgentIdRef.current === agentId &&
				vaultPathRef.current === requestVaultPath &&
				loadModelPref(agentId) === next,
			stillWarming: () =>
				selectedAgentIdRef.current === agentId &&
				vaultPathRef.current === requestVaultPath,
		});
	};

	const pickReasoningEffort = useCallback(
		(id: string) => {
			if (!selectedAgentId || !effortOptions.some((option) => option.id === id))
				return;
			saveReasoningEffortPref(selectedAgentId, id);
			setReasoningEffort(id);
		},
		[effortOptions, selectedAgentId],
	);

	const toggleFavorite = useCallback(
		(id: string) => {
			if (!selectedAgentId) return;
			setFavoriteIds((prev) => {
				const next = prev.includes(id)
					? prev.filter((x) => x !== id)
					: [...prev, id];
				saveModelFavorites(selectedAgentId, next);
				return next;
			});
		},
		[selectedAgentId],
	);

	return {
		registry,
		catalog,
		skills,
		models,
		modelId,
		favoriteIds,
		modelSelectorOpen,
		setModelSelectorOpen,
		warming,
		agentListenersReady,
		setAgentListenersReady,
		usage,
		setUsage,
		usageBySession,
		setUsageBySession,
		acpCommandsByAgent,
		setAcpCommandsByAgent,
		collaborationOptions,
		collaborationModeId,
		effortOptions,
		reasoningEffort,
		pickReasoningEffort,
		fastAvailable,
		fastEnabled,
		setFastEnabled,
		applyModelsEvent,
		applyCollaborationEvent,
		applyEffortEvent,
		applyFastModeEvent,
		refresh,
		selectedModelName,
		groupedModels,
		selectedCollaborationName,
		pickCollaborationMode,
		pickModel,
		toggleFavorite,
	};
}
