import type { DockviewApi, IDockviewPanel } from "dockview-react";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import { layout, setLayoutMode, uiStore } from "@/lib/shell/ui-store";
import { getVaultPath, vaultLoadGeneration } from "@/lib/vault/store";
import type {
	SidebarFileData,
	SidebarFileTarget,
} from "@/lib/workspace/sidebar-files";
import { currentWindowLabel } from "@/lib/workspace/store";
import { createViewId } from "@/lib/workspace/tabs/model";
import { markdownEditorFor } from "@/lib/workspace/viewer/markdown-editor-registry";

export type SidebarTarget =
	| { kind: "agent"; scopeId: string | null }
	| SidebarFileTarget;
export type SidebarPanelTarget =
	| SidebarTarget
	| { kind: "launcher"; notesPath?: string };
export type SidebarTab = { viewId: string; target: SidebarTarget };
export type SidebarSnapshot = {
	tabs: SidebarTab[];
	activeViewId: string | null;
	expanded: boolean;
};

export type SidebarPanelParams = {
	target: SidebarPanelTarget;
	file?: SidebarFileData;
};
type OpenOptions = {
	replace?: string;
	canOpen?: () => boolean;
	file?: SidebarFileData;
};

export const DEFAULT_SIDEBAR_AGENT = { kind: "agent", scopeId: null } as const;

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
			return target.scopeId === null || typeof target.scopeId === "string";
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
	const generation = vaultLoadGeneration();
	let disposed = false;
	let ready = false;
	let savedJson: string | null = null;
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
		const snapshot: SidebarSnapshot = {
			tabs,
			activeViewId: tabs.some((tab) => tab.viewId === activeViewId)
				? activeViewId
				: null,
			expanded: uiStore.getState().rightSidebarOpen,
		};
		const json = JSON.stringify(snapshot);
		if (savedJson === json) return;
		savedJson = json;
		writeJsonStorage(key, snapshot);
	};
	const subscriptions = [
		api.onDidLayoutChange(save),
		api.onDidActivePanelChange(save),
		uiStore.subscribe((state, previous) => {
			if (state.rightSidebarOpen !== previous.rightSidebarOpen) save();
		}),
	];
	const restore = async () => {
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
		if (vaultLoadGeneration() !== generation) return;
		for (const { viewId, target } of tabs) {
			if (target && !api.getPanel(viewId) && !find(target)) add(target, viewId);
		}
		if (!panels().length)
			add(saved ? { kind: "launcher" } : DEFAULT_SIDEBAR_AGENT);
		const active =
			(saved?.activeViewId && api.getPanel(saved.activeViewId)) || panels()[0];
		active?.api.setActive();
		layout()?.setRightCollapsed(
			!(saved?.expanded ?? uiStore.getState().rightSidebarOpen),
		);
		ready = true;
		save();
	};
	return {
		vaultPath,
		restore,
		get ready() {
			return ready;
		},
		openOrActivate(target: SidebarPanelTarget, { replace, file }: OpenOptions) {
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
	if (uiStore.getState().immersiveReading || !getVaultPath()) return;
	setExpanded(!uiStore.getState().rightSidebarOpen);
}
