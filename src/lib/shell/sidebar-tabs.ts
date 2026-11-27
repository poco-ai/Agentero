import type {
	DockviewApi,
	DockviewWillDropEvent,
	DockviewWillShowOverlayLocationEvent,
	IDockviewPanel,
} from "dockview-react";
import { createStore } from "zustand/vanilla";
import { isAgentDockPath } from "@/lib/agent/agent-dock-path";
import type { AgentSessionRef } from "@/lib/agent/session-ref";
import { readJsonStorage, writeStorageRaw } from "@/lib/core/storage";
import { cancelPdfNavigationForTab } from "@/lib/pdf/pending-pdf-page";
import {
	layout,
	readingRightSidebarOpen,
	setLayoutMode,
	uiStore,
} from "@/lib/shell/ui-store";
import { getVaultPath, vaultLoadGeneration } from "@/lib/vault/store";
import {
	type SidebarBrowserTarget,
	sidebarBrowserUrl,
} from "@/lib/web-view/sidebar-browser-url";
import { isCrossDockTransfer } from "@/lib/workspace/dock-transfer-registry";
import type {
	SidebarFileData,
	SidebarFileTarget,
} from "@/lib/workspace/sidebar-files";
import { currentWindowLabel } from "@/lib/workspace/store";
import {
	extractTabsFromLayout,
	workspaceLayoutStorageKey,
} from "@/lib/workspace/tabs";
import { createViewId } from "@/lib/workspace/tabs/model";
import { markdownEditorFor } from "@/lib/workspace/viewer/markdown-editor-registry";

export type SidebarAgentTarget = {
	kind: "agent";
	scopeId: string | null;
	sessionRef?: AgentSessionRef;
	agentId?: string;
};
export type SidebarTarget =
	| SidebarAgentTarget
	| SidebarFileTarget
	| SidebarBrowserTarget;
export type SidebarPanelTarget =
	| SidebarTarget
	| { kind: "launcher"; notesPath?: string | null; focusSearch?: boolean };
type SidebarTab = { viewId: string; target: SidebarTarget };
type SidebarSnapshot = {
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

export function restrictSidebarTabDrop(
	event: DockviewWillDropEvent | DockviewWillShowOverlayLocationEvent,
) {
	const source = event.getData();
	// The main workspace may hand a panel to the rail; the drop handler builds
	// the rail tab. Everything else must stay inside this single group.
	if (isCrossDockTransfer(source, "sidebar")) return;
	if (
		(event.kind !== "tab" && event.kind !== "header_space") ||
		!source?.panelId ||
		source.viewId !== event.api.id ||
		source.groupId !== event.group?.id
	) {
		event.preventDefault();
	}
}

function storageKey(vaultPath: string): string {
	return `agentero-sidebar-tabs::${currentWindowLabel()}::${vaultPath}`;
}

function targetOf(panel: IDockviewPanel): SidebarPanelTarget {
	return (panel.params as { target: SidebarPanelTarget }).target;
}

function sameTarget(left: SidebarPanelTarget, right: SidebarPanelTarget) {
	if (left.kind === "launcher" || right.kind === "launcher") return false;
	if (left.kind === "agent" || right.kind === "agent") {
		return (
			left.kind === "agent" &&
			right.kind === "agent" &&
			left.scopeId === right.scopeId
		);
	}
	if (left.kind === "browser" || right.kind === "browser") {
		return (
			left.kind === "browser" &&
			right.kind === "browser" &&
			left.url !== null &&
			left.url === right.url
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
		case "browser":
			return (
				target.url === null ||
				(typeof target.url === "string" &&
					/^https?:\/\//i.test(target.url) &&
					sidebarBrowserUrl(target.url) !== null)
			);
		default:
			return false;
	}
}

/**
 * Agent scopes the main workspace already hosts. A crash between the two
 * snapshot writes can leave the same conversation in both layouts; the main
 * panel is the long-lived one, so the rail skips it.
 */
function agentScopesHostedByMain(vaultPath: string): Set<string | null> {
	const key = workspaceLayoutStorageKey(currentWindowLabel(), vaultPath);
	const saved = readJsonStorage<{ layout?: unknown } | null>(key, null);
	const hosted = new Set<string | null>();
	if (!saved?.layout) return hosted;
	for (const tab of extractTabsFromLayout(saved.layout).tabs) {
		if (isAgentDockPath(tab.path)) hosted.add(tab.agentScopeId ?? null);
	}
	return hosted;
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
	layout()?.setRightCollapsed(!expanded, true);
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
			expanded: readingRightSidebarOpen(),
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
		api.onDidMovePanel(save),
		api.onDidActivePanelChange(syncActive),
		api.onWillShowOverlay(restrictSidebarTabDrop),
		api.onWillDrop(restrictSidebarTabDrop),
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
		const hostedAgentScopes = agentScopesHostedByMain(vaultPath);
		for (const { viewId, target } of tabs) {
			if (target?.kind === "agent" && hostedAgentScopes.has(target.scopeId)) {
				continue;
			}
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
			expandedDuringRestore ?? saved?.expanded ?? readingRightSidebarOpen();
		// The restored arrangement is part of the launch paint, not a slide.
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
			else if (expanded && !panels().length) add({ kind: "launcher" });
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
		updateBrowser(viewId: string, url: string, title: string) {
			const panel = api.getPanel(viewId);
			if (!panel) return;
			const target = targetOf(panel);
			if (target.kind !== "browser") return;
			if (target.url !== url)
				panel.api.updateParameters({
					target: { kind: "browser", url } satisfies SidebarBrowserTarget,
				});
			if (panel.api.title !== title) panel.api.setTitle(title);
			save();
		},
		hasPanel(viewId: string) {
			return Boolean(api.getPanel(viewId));
		},
		panelTarget(viewId: string) {
			const panel = api.getPanel(viewId);
			return panel ? targetOf(panel) : undefined;
		},
		/**
		 * Drop a panel because its content now lives in the main workspace.
		 * When that empties the rail, collapse it instead of leaving an empty
		 * column; the launcher is parked for the next expansion.
		 */
		removeForTransfer(viewId: string) {
			const panel = api.getPanel(viewId);
			if (!panel) return;
			panel.api.close();
			if (!panels().length) {
				setExpanded(false);
				add({ kind: "launcher" });
			}
			save();
		},
		activeViewId() {
			return api.activePanel?.id;
		},
		onlyViewId() {
			const tabs = panels();
			return tabs.length === 1 ? tabs[0].id : undefined;
		},
		/**
		 * Force the rail's Dockview to the width it is about to animate to. The
		 * rail pins its content while the panel width slides, so Dockview only
		 * sees one size change; handing it the final size up front keeps the
		 * panels laid out at that width from the first frame.
		 */
		relayout(width: number) {
			if (disposed || !ready) return;
			const height = api.height;
			if (width <= 0 || height <= 0) return;
			api.layout(width, height, true);
		},
		cycleTab(delta: -1 | 1) {
			const tabs = panels();
			if (tabs.length < 2) return;
			const index = tabs.findIndex((panel) => panel.id === api.activePanel?.id);
			const next =
				index < 0
					? delta > 0
						? 0
						: tabs.length - 1
					: (index + delta + tabs.length) % tabs.length;
			tabs[next].api.setActive();
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
			if (panels().length === 1) setExpanded(false);
			panel.api.close();
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

/** Lay the rail's Dockview out at the width its slide will settle on. */
export function relayoutSidebarDock(width: number) {
	dock?.relayout(width);
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

export function updateSidebarBrowser(
	viewId: string,
	url: string,
	title: string,
) {
	dock?.updateBrowser(viewId, url, title);
}

export function isSidebarView(viewId: string): boolean {
	return dock?.hasPanel(viewId) ?? false;
}

export function sidebarPanelTarget(
	viewId: string,
): SidebarPanelTarget | undefined {
	return dock?.panelTarget(viewId);
}

/** Remove a rail panel whose content the main workspace now hosts. */
export function removeSidebarViewForTransfer(viewId: string): void {
	dock?.removeForTransfer(viewId);
}

export function activeSidebarViewId(): string | undefined {
	return dock?.activeViewId();
}

export function onlySidebarViewId(): string | undefined {
	return dock?.onlyViewId();
}

export function cycleSidebarTab(delta: -1 | 1): void {
	dock?.cycleTab(delta);
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
