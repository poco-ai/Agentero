import { useEffect, useMemo, useState } from "react";
import { VoiceDefenseDialog } from "@/components/agent/voice-defense-dialog";
import {
	useLibraryStore,
	useSelectionStore,
	useSettings,
	useVaultStore,
	useWorkspaceStore,
} from "@/hooks/use-app-stores";
import { useAgentSessionStore } from "@/lib/agent/agent-session-store";
import { listAgents, loadModelPref } from "@/lib/agent/api";
import {
	contextPathDisplayName,
	contextPathLabel,
	normalizeContextPath,
	toPathSet,
} from "@/lib/agent/context-path-icon";
import type { SelectionContext } from "@/lib/agent/selection-store";
import { normalizeAgentSourcePath } from "@/lib/agent/sources";
import { toVaultRelative } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import { isLibraryVirtualPath, isTrashVirtualPath } from "@/lib/paper/api";
import { paperDirFromPath } from "@/lib/paper/detect";
import { openDocWindow } from "@/lib/shell/doc-window";
import { openGraphPath } from "@/lib/workspace/actions";

function handleOpenSource(source: string, windowMode: boolean): void {
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
	if (windowMode) {
		void openDocWindow(trimmed);
		return;
	}
	openGraphPath(trimmed);
}

/**
 * Shell-level viva host. Lives outside the Agent rail so the title-bar
 * microphone can open a defense without mounting or revealing the sidebar.
 * Desktop uses `windowMode` inside the singleton viva window; browser preview
 * still mounts this as a full-screen overlay on the main page.
 */
export function VoiceDefenseHost({
	windowMode = false,
	followedPath,
	followedPaperTitle,
	handoffSelections,
	handoffAgentId,
	handoffModelId,
}: {
	windowMode?: boolean;
	followedPath?: string | null;
	followedPaperTitle?: string | null;
	handoffSelections?: SelectionContext[];
	handoffAgentId?: string | null;
	handoffModelId?: string | null;
} = {}) {
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const vaultDefenseMaterialPaths = useVaultStore(
		(s) => s.vaultDefenseMaterialFiles,
	);
	const vaultDirectoryPaths = useVaultStore((s) => s.vaultDirPaths);
	const vaultPaperPaths = useVaultStore((s) => s.vaultPaperPaths);
	const paperMetaByRelPath = useLibraryStore((s) => s.paperMetaByRelPath);
	const paperTreeLabelMode = useSettings((s) => s.paperTreeLabelMode);
	const workspaceSelectedPath = useWorkspaceStore(
		(s) => s.tabs.find((tab) => tab.id === s.activeTabId)?.path ?? null,
	);
	const workspaceSelectedPaperTitle = useWorkspaceStore(
		(s) =>
			s.tabs.find((tab) => tab.id === s.activeTabId)?.paperMeta?.title ?? null,
	);
	const selectedPath =
		followedPath !== undefined ? followedPath : workspaceSelectedPath;
	const selectedPaperTitle =
		followedPaperTitle !== undefined
			? followedPaperTitle
			: workspaceSelectedPaperTitle;
	const sessionAgentId = useAgentSessionStore((s) => {
		const active = s.sessions.find((item) => item.id === s.activeTabId);
		return active?.agentId ?? s.sessions[0]?.agentId ?? null;
	});
	const activeSelection = useSelectionStore((s) => s.active);
	const pinnedSelections = useSelectionStore((s) => s.pinned);
	const storeSelections = useMemo(
		() =>
			activeSelection
				? [...pinnedSelections, activeSelection]
				: pinnedSelections,
		[activeSelection, pinnedSelections],
	);
	const selections = handoffSelections ?? storeSelections;
	const [fallbackAgentId, setFallbackAgentId] = useState<string | null>(null);

	useEffect(() => {
		if (!isTauri() || !vaultPath) {
			setFallbackAgentId(null);
			return;
		}
		let cancelled = false;
		void listAgents()
			.then((registry) => {
				if (cancelled) return;
				setFallbackAgentId(registry.defaultId);
			})
			.catch(() => {
				if (!cancelled) setFallbackAgentId(null);
			});
		return () => {
			cancelled = true;
		};
	}, [vaultPath]);

	const selectedAgentId = handoffAgentId || sessionAgentId || fallbackAgentId;
	const modelId =
		handoffModelId ?? (selectedAgentId ? loadModelPref(selectedAgentId) : null);

	const paperPathSet = useMemo(
		() => toPathSet(vaultPaperPaths),
		[vaultPaperPaths],
	);
	const pathLabelOptions = useMemo(
		() => ({
			paperPaths: paperPathSet,
			paperMetaByRelPath,
			paperTreeLabelMode,
		}),
		[paperMetaByRelPath, paperPathSet, paperTreeLabelMode],
	);

	const focusedMaterialPath = useMemo(() => {
		if (!selectedPath) return null;
		if (
			isLibraryVirtualPath(selectedPath) ||
			isTrashVirtualPath(selectedPath)
		) {
			return null;
		}
		const relative = toVaultRelative(vaultPath, selectedPath);
		if (!relative) return null;
		if (isLibraryVirtualPath(relative) || isTrashVirtualPath(relative)) {
			return null;
		}
		return paperDirFromPath(relative, vaultPaperPaths) ?? relative;
	}, [selectedPath, vaultPath, vaultPaperPaths]);

	const currentFileLabel = useMemo(() => {
		if (!focusedMaterialPath) return "";
		const labeled = contextPathLabel(focusedMaterialPath, pathLabelOptions);
		if (labeled && labeled !== contextPathDisplayName(focusedMaterialPath)) {
			return labeled;
		}
		const title = selectedPaperTitle?.trim();
		if (title && paperPathSet.has(normalizeContextPath(focusedMaterialPath))) {
			return title;
		}
		return labeled || contextPathDisplayName(focusedMaterialPath);
	}, [focusedMaterialPath, paperPathSet, pathLabelOptions, selectedPaperTitle]);

	const focusedPaperMetadata = focusedMaterialPath
		? (paperMetaByRelPath?.get(normalizeContextPath(focusedMaterialPath)) ??
			null)
		: null;

	const materialOptions = useMemo(() => {
		const options: Array<{
			path: string;
			kind: "file" | "directory";
			label: string;
		}> = [];
		const seen = new Set<string>();
		const append = (path: string, kind: "file" | "directory") => {
			const normalized = normalizeContextPath(path);
			if (!normalized || seen.has(normalized)) return;
			seen.add(normalized);
			options.push({
				path: normalized,
				kind,
				label: contextPathLabel(normalized, pathLabelOptions),
			});
		};
		for (const path of vaultDirectoryPaths) append(path, "directory");
		for (const path of vaultDefenseMaterialPaths) append(path, "file");
		return options;
	}, [pathLabelOptions, vaultDefenseMaterialPaths, vaultDirectoryPaths]);

	return (
		<VoiceDefenseDialog
			windowMode={windowMode}
			vaultPath={vaultPath}
			currentFileLabel={currentFileLabel}
			focusedMaterialPath={focusedMaterialPath}
			materialOptions={materialOptions}
			paperMetadata={focusedPaperMetadata}
			selectedPaperTitle={selectedPaperTitle}
			selectedAgentId={selectedAgentId}
			modelId={modelId}
			selections={selections}
			onOpenSource={(source) => handleOpenSource(source, windowMode)}
		/>
	);
}
