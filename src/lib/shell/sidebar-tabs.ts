import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { createStore } from "zustand/vanilla";
import type { AgentSessionRef } from "@/lib/agent/session-ref";
import { readJsonStorage, writeStorageRaw } from "@/lib/core/storage";
import { cancelPdfNavigationForTab } from "@/lib/pdf/pending-pdf-page";
import { layout, setLayoutMode, uiStore } from "@/lib/shell/ui-store";
import { getVaultPath, vaultLoadGeneration } from "@/lib/vault/store";
import type {
	SidebarFileData,
	SidebarFileTarget,
} from "@/lib/workspace/sidebar-files";
import { currentWindowLabel } from "@/lib/workspace/store";
import { createViewId } from "@/lib/workspace/tabs/model";
import { markdownEditorFor } from "@/lib/workspace/viewer/markdown-editor-registry";

export type SidebarAgentTarget = {
	kind: "agent";
	scopeId: string | null;
	sessionRef?: AgentSessionRef;
	agentId?: string;
};
export type SidebarTarget = SidebarAgentTarget | SidebarFileTarget;
export type SidebarPanelTarget =
	| SidebarTarget
	| { kind: "launcher"; notesPath?: string };
export type SidebarTab = { viewId: string; target: SidebarTarget };
export type SidebarSnapshot = {
	tabs: SidebarTab[];
	activeViewId: string | null;
	expanded: boolean;
	lastAgentViewId?: string;
};

export type SidebarPanelParams = {
	target: SidebarPanelTarget;
	file?: SidebarFileData;
};
type OpenOptions = {
	replace?: string;
	canOpen?: () => boolean;
	file?: SidebarFileData;
	onOpen?: (viewId: string) => void;
};

export const DEFAULT_SIDEBAR_AGENT = { kind: "agent", scopeId: null } as const;

export const sidebarChatState = createStore<{
	scopeId: string | null;
	sessionId: string;
}>(() => ({ scopeId: null, sessionId: "draft" }));

type DockOptions = {
	title: (target: SidebarPanelTarget) => string;
	restoreTarget?: (target: SidebarTarget) => Promise<SidebarTarget | null>;
};

function storageKey(vaultPath: string): string {
	return `agentero-sidebar-tabs::${currentWindowLabel()}::${vaultPath}`;
}

function targetOf(panel: IDockviewPanel): SidebarPanelTarget {
	return (panel.params as { target: SidebarPanelTarget }).target;
}

function sameTarget(left: SidebarPanelTarget, right: SidebarPanelTarget) {
	if (left.kind === "launcher" || right.kind === "launcher") {
		return (
			left.kind === "launcher" &&
			right.kind === "launcher" &&
			left.notesPath === right.notesPath
		);
	}
	if (left.kind === "agent" || right.kind === "agent") {
		return (
			left.kind === "agent" &&
			right.kind === "agent" &&
			left.scopeId === right.scopeId
		);
	}
	return left.kind === right.kind && left.vaultRelPath === right.vaultRelPath;
}

function isSidebarTarget(target: SidebarTarget | undefined): boolean {
	switch (target?.kind) {
		case "agent":
			return (
				(target.scopeId === null || typeof target.scopeId === "string") &&
				(!target.sessionRef ||
					(typeof target.sessionRef.providerSessionId === "string" &&
						typeof target.sessionRef.agentId === "string" &&
						typeof target.sessionRef.id === "string"))
			);
		case "pdf":
		case "notes":
		case "html":
			return typeof target.vaultRelPath === "string";
		default:
			return false;
	}
}

function readSnapshot(key: string): SidebarSnapshot | null {
	const saved = readJsonStorage<SidebarSnapshot | null>(key, null);
	if (
		!saved ||
		typeof saved.expanded !== "boolean" ||
		!Array.isArray(saved.tabs)
	) {
		return null;
	}
	return {
		...saved,
		tabs: saved.tabs.filter(
			(tab) => typeof tab?.viewId === "string" && isSidebarTarget(tab.target),
		),
	};
}

type SidebarDock = ReturnType<typeof createSidebarDock>;
let dock: SidebarDock | null = null;
let pending: ((dock: SidebarDock) => void)[] = [];

function setExpanded(expanded: boolean) {
	setLayoutMode("custom");
	layout()?.setRightCollapsed(!expanded);
}

function createSidebarDock(
	api: DockviewApi,
	vaultPath: string,
	options: DockOptions,
) {
	const key = storageKey(vaultPath);
	let disposed = false;
	let ready = false;
	let savedJson: string | null = null;
	let expandedDuringRestore: boolean | undefined;
	const current = () => !disposed && getVaultPath() === vaultPath;
	const panels = () => api.groups[0]?.panels ?? [];
	const find = (target: SidebarPanelTarget) =>
		panels().find((panel) => sameTarget(targetOf(panel), target));
	const add = (
		target: SidebarPanelTarget,
		viewId = createViewId(),
		index?: number,
		file?: SidebarFileData,
	) => {
		const group = api.groups[0];
		return api.addPanel({
			id: viewId,
			component: target.kind,
			params: { target, file } satisfies SidebarPanelParams,
			title: options.title(target),
			renderer: "always",
			...(group
				? { position: { referenceGroup: group, direction: "within", index } }
				: {}),
		});
	};
	const save = () => {
		if (!ready || !current() || uiStore.getState().immersiveReading) return;
		const tabs = panels().flatMap((panel): SidebarTab[] => {
			const target = targetOf(panel);
			return target.kind === "launcher" ? [] : [{ viewId: panel.id, target }];
		});
		const activeViewId = api.activePanel?.id ?? null;
		const lastAgentViewId = tabs.find(
			({ target }) =>
				target.kind === "agent" &&
				target.scopeId === sidebarChatState.getState().scopeId,
		)?.viewId;
		const snapshot: SidebarSnapshot = {
			tabs,
			activeViewId: tabs.some((tab) => tab.viewId === activeViewId)
				? activeViewId
				: null,
			expanded: uiStore.getState().rightSidebarOpen,
			lastAgentViewId,
		};
		const json = JSON.stringify(snapshot);
		if (savedJson === json) return;
		if (writeStorageRaw(key, json)) savedJson = json;
	};
	const syncActive = () => {
		if (!ready || !current()) return;
		const active = api.activePanel && targetOf(api.activePanel);
		if (active?.kind === "agent") {
			const sessionId = active.sessionRef?.id ?? "draft";
			const state = sidebarChatState.getState();
			if (state.scopeId !== active.scopeId || state.sessionId !== sessionId)
				sidebarChatState.setState({ scopeId: active.scopeId, sessionId });
		} else if (
			!panels().some((panel) => {
				const target = targetOf(panel);
				return (
					target.kind === "agent" &&
					target.scopeId === sidebarChatState.getState().scopeId
				);
			})
		) {
			const recent = panels()
				.map(targetOf)
				.reverse()
				.find((target) => target.kind === "agent");
			if (recent || sidebarChatState.getState().scopeId !== null) {
				sidebarChatState.setState({
					scopeId: recent?.scopeId ?? null,
					sessionId: recent?.sessionRef?.id ?? "draft",
				});
			}
		}
		save();
	};
	const subscriptions = [
		api.onDidLayoutChange(syncActive),
		api.onDidActivePanelChange(syncActive),
		api.onDidRemovePanel((panel) => cancelPdfNavigationForTab(panel.id)),
		uiStore.subscribe((state, previous) => {
			if (
				state.rightSidebarOpen !== previous.rightSidebarOpen ||
				state.immersiveReading !== previous.immersiveReading
			)
				save();
		}),
	];
	const restore = async () => {
		const generation = vaultLoadGeneration();
		const saved = readSnapshot(key);
		const tabs = await Promise.all(
			(saved?.tabs ?? []).map(async (tab) => ({
				viewId: tab.viewId,
				target: options.restoreTarget
					? await options.restoreTarget(tab.target)
					: tab.target,
			})),
		);
		if (!current()) return;
		if (vaultLoadGeneration() !== generation) return restore();
		for (const { viewId, target } of tabs) {
			if (target && !api.getPanel(viewId) && !find(target)) add(target, viewId);
		}
		if (!panels().length)
			add(saved ? { kind: "launcher" } : DEFAULT_SIDEBAR_AGENT);
		const active =
			(saved?.activeViewId && api.getPanel(saved.activeViewId)) || panels()[0];
		active?.api.setActive();
		const lastAgent = saved?.lastAgentViewId
			? api.getPanel(saved.lastAgentViewId)
			: undefined;
		const target = lastAgent && targetOf(lastAgent);
		sidebarChatState.setState({
			scopeId: target?.kind === "agent" ? target.scopeId : null,
			sessionId:
				target?.kind === "agent" ? (target.sessionRef?.id ?? "draft") : "draft",
		});
		const expanded =
			expandedDuringRestore ??
			saved?.expanded ??
			uiStore.getState().rightSidebarOpen;
		if (!uiStore.getState().immersiveReading)
			layout()?.setRightCollapsed(!expanded);
		ready = true;
		syncActive();
	};
	return {
		vaultPath,
		restore,
		get ready() {
			return ready;
		},
		toggle() {
			const expanded = !uiStore.getState().rightSidebarOpen;
			if (!ready) expandedDuringRestore = expanded;
			setExpanded(expanded);
		},
		agents() {
			return panels()
				.map(targetOf)
				.filter(
					(target): target is SidebarAgentTarget => target.kind === "agent",
				);
		},
		updateAgent(viewId: string, target: SidebarAgentTarget) {
			const panel = api.getPanel(viewId);
			if (!panel) return;
			panel.api.updateParameters({ target });
			panel.api.setTitle(options.title(target));
			if (sidebarChatState.getState().scopeId === target.scopeId) {
				sidebarChatState.setState({
					sessionId: target.sessionRef?.id ?? "draft",
				});
			}
			save();
		},
		pdfPath(viewId: string) {
			const panel = api.getPanel(viewId);
			const target = panel && targetOf(panel);
			return target?.kind === "pdf" ? target.vaultRelPath : undefined;
		},
		hasPanel(viewId: string) {
			return Boolean(api.getPanel(viewId));
		},
		openOrActivate(
			target: SidebarPanelTarget,
			{ replace, file, onOpen }: OpenOptions,
		) {
			const replaced = replace ? api.getPanel(replace) : undefined;
			const existing = find(target);
			const panel =
				existing ??
				add(
					target,
					undefined,
					replaced ? panels().indexOf(replaced) : undefined,
					file,
				);
			if (
				replaced &&
				replaced !== panel &&
				targetOf(replaced).kind === "launcher"
			) {
				api.removePanel(replaced);
			}
			panel.api.setActive();
			if (!uiStore.getState().rightSidebarOpen) setExpanded(true);
			onOpen?.(panel.id);
			save();
			return panel.id;
		},
		close(viewId: string) {
			const panel = api.getPanel(viewId);
			if (!panel) return;
			if (panels().length === 1 && targetOf(panel).kind !== "launcher") {
				add({ kind: "launcher" });
			}
			if (panels().length === 1) {
				setExpanded(false);
				return;
			}
			api.removePanel(panel);
			save();
		},
		dispose() {
			disposed = true;
			for (const panel of panels()) cancelPdfNavigationForTab(panel.id);
			for (const subscription of subscriptions) {
				if (typeof subscription === "function") subscription();
				else subscription.dispose();
			}
		},
	};
}

export function connectSidebarDock(
	api: DockviewApi,
	vaultPath: string,
	options: DockOptions,
) {
	const next = createSidebarDock(api, vaultPath, options);
	dock = next;
	void next.restore().then(() => {
		if (dock !== next || !next.ready) return;
		const intents = pending;
		pending = [];
		for (const intent of intents) intent(next);
	});
	return () => {
		next.dispose();
		if (dock === next) dock = null;
	};
}

export function sidebarAgentTargets(): SidebarAgentTarget[] {
	return dock?.agents() ?? [];
}

export function updateSidebarAgentTarget(
	viewId: string,
	target: SidebarAgentTarget,
) {
	dock?.updateAgent(viewId, target);
}

export function isSidebarView(viewId: string): boolean {
	return dock?.hasPanel(viewId) ?? false;
}

export function sidebarPdfPath(viewId: string): string | undefined {
	return dock?.pdfPath(viewId);
}

export function openOrActivateSidebarTarget(
	target: SidebarPanelTarget,
	options: OpenOptions = {},
): Promise<string | undefined> {
	const vaultPath = getVaultPath();
	const { canOpen = () => true } = options;
	if (!vaultPath || !canOpen()) return Promise.resolve(undefined);
	if (dock?.vaultPath === vaultPath && dock.ready) {
		return Promise.resolve(dock.openOrActivate(target, options));
	}
	const generation = vaultLoadGeneration();
	return new Promise((resolve) => {
		pending.push((next) =>
			resolve(
				next.vaultPath === vaultPath &&
					vaultLoadGeneration() === generation &&
					canOpen()
					? next.openOrActivate(target, options)
					: undefined,
			),
		);
	});
}

export async function closeSidebarTab(viewId: string) {
	const current = dock;
	const editor = markdownEditorFor(viewId);
	if (editor?.hasPendingSource() && !(await editor.flushSource())) return;
	if (dock === current) current?.close(viewId);
}

export function toggleSidebarTabs() {
	const vaultPath = getVaultPath();
	if (uiStore.getState().immersiveReading || !vaultPath) return;
	if (dock?.vaultPath === vaultPath) dock.toggle();
	else setExpanded(!uiStore.getState().rightSidebarOpen);
}
