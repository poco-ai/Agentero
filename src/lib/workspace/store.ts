/**
 * Workspace (dockview panels) state — zustand vanilla.
 * Tabs are the flat panel list; layout is owned by dockview (`toJSON()` blob).
 * Plain modules read the latest snapshot via `getState()`, which replaces the
 * old tabsRef/activeTabIdRef mirrors in App.
 */

import { getCurrentWindow } from "@tauri-apps/api/window";
import { createStore } from "zustand/vanilla";
import { isZenVirtualPath } from "@/lib/agent/zen-path";
import { perfActive } from "@/lib/core/perf";
import { isTauri } from "@/lib/core/tauri";
import { isFreshWindow } from "@/lib/vault/session";
import { getVaultPath } from "@/lib/vault/store";
import {
	createPlaceholderTab,
	type DocTab,
	loadWindowVaultLayout,
	patchTab,
	seedTabs,
} from "@/lib/workspace/tabs";
import type { PersistedTabs } from "@/lib/workspace/tabs/types";
import { type CenterViewMode, viewerModeSpec } from "@/lib/workspace/viewer";

/** Closed panel remembered for ⇧⌘T (reopen), newest last. */
export type ClosedTab = {
	path: string;
	mode?: CenterViewMode;
	/** Owning writing project; reopen goes through the project panel, not a new tab. */
	writingRoot?: string;
};

const CLOSED_TAB_HISTORY = 10;

type WorkspaceStore = {
	/** Open document panels (flat list; layout owned by global dockview). */
	tabs: DocTab[];
	activeTabId: string | null;
	/** Global dockview grid snapshot (panel ids = tab ids). */
	dockLayout: unknown | null;
	/** Most-recently-viewed PDF tab ids kept mounted (see PDF_TAB_MOUNT_LRU). */
	pdfLru: string[];
	/** Most-recently-viewed Markdown editor tab ids kept mounted (see EDITOR_TAB_MOUNT_LRU). */
	editorLru: string[];
	/** Recently closed panels (ephemeral, never persisted). */
	closedTabs: ClosedTab[];
};

export const workspaceStore = createStore<WorkspaceStore>(() => ({
	tabs: [],
	activeTabId: null,
	dockLayout: null,
	pdfLru: [],
	editorLru: [],
	closedTabs: [],
}));

let initialized = false;

/** Tauri window label. Tests and non-Tauri callers share the primary label. */
export function currentWindowLabel(): string {
	if (!isTauri()) return "main";
	try {
		return getCurrentWindow().label || "main";
	} catch {
		return "main";
	}
}

function withPersistedPane(tab: DocTab, pane: DocTab["pane"]): DocTab {
	if (pane !== "split" && pane !== "translation") return tab;
	return tab.pane === pane ? tab : { ...tab, pane };
}

function tabsFromPersisted(persisted: PersistedTabs): DocTab[] {
	// The Zen tab was replaced by the title-bar Agent workspace; drop stale
	// entries from layouts saved by older builds.
	return persisted.tabs
		.filter((pt) => !isZenVirtualPath(pt.path))
		.map((pt) => {
			const tab = createPlaceholderTab(pt.path, pt.mode, pt.id);
			// Restore the owning writing project up front so every branch below —
			// including hydration placeholders — keeps the one-panel project identity.
			if (pt.writingRoot) tab.writingRoot = pt.writingRoot;
			// Registry-declared restore override. Translation panes stay paper-kind
			// and keep their view id; `loaded: false` lets hydration read the path.
			const restore = viewerModeSpec(pt.mode).restore;
			if (restore) {
				return withPersistedPane(
					{
						...tab,
						kind: restore.kind,
						title: pt.title || restore.fallbackTitle,
						loaded: restore.loaded,
					},
					pt.pane,
				);
			}
			if (pt.texRoot) tab.texRoot = pt.texRoot;
			// Realtime TeX panes have no file seed to hydrate; restore them
			// loaded so the viewer remounts instead of showing a skeleton.
			if (pt.texLive) {
				return withPersistedPane(
					{
						...tab,
						loaded: true,
						texLive: true,
						texRoot: pt.texRoot,
					},
					pt.pane,
				);
			}
			// Real-path placeholders default to the folder basename; prefer the
			// persisted title so strips show paper names before hydration.
			if (pt.title && tab.kind === "file") {
				return withPersistedPane({ ...tab, title: pt.title }, pt.pane);
			}
			return withPersistedPane(tab, pt.pane);
		});
}

function applyPersistedWorkspace(persisted: PersistedTabs | null): void {
	if (!persisted?.tabs.length) {
		workspaceStore.setState({
			tabs: [],
			activeTabId: null,
			dockLayout: null,
		});
		return;
	}
	const tabs = tabsFromPersisted(persisted);
	workspaceStore.setState({
		tabs,
		activeTabId:
			persisted.activeId && tabs.some((tab) => tab.id === persisted.activeId)
				? persisted.activeId
				: (tabs[0]?.id ?? null),
		dockLayout: persisted.layout ?? null,
	});
}

/** Drop open panels and the saved snapshot without reading storage. */
export function clearWorkspace(): void {
	applyPersistedWorkspace(null);
}

/**
 * Replace open panels with the layout saved for this window and vault.
 * Returns the dock snapshot the caller should apply when the dock is mounted.
 * Outside Tauri the workspace is cleared and nothing is read.
 */
export function replaceWorkspaceForVault(vaultPath: string): unknown | null {
	if (!isTauri()) {
		applyPersistedWorkspace(null);
		return null;
	}
	const persisted = loadWindowVaultLayout(
		currentWindowLabel(),
		vaultPath,
		isFreshWindow(),
	);
	applyPersistedWorkspace(persisted);
	return persisted?.layout ?? null;
}

/**
 * Seed open panels + layout from localStorage before first paint so
 * DockWorkspace onReady can fromJSON before any membership sync.
 * Document and feature windows pass `restoreLayout: false` — they do not
 * own this window's dock session.
 */
export function initWorkspaceStore(options?: {
	restoreLayout?: boolean;
}): void {
	if (initialized) return;
	initialized = true;
	if (options?.restoreLayout === false) return;
	if (!isTauri() || perfActive()) return;
	const vaultPath = getVaultPath();
	if (!vaultPath) return;
	applyPersistedWorkspace(
		loadWindowVaultLayout(currentWindowLabel(), vaultPath, isFreshWindow()),
	);
}

export function getTabs(): DocTab[] {
	return workspaceStore.getState().tabs;
}

export function getActiveTabId(): string | null {
	return workspaceStore.getState().activeTabId;
}

export function getActiveTab(): DocTab | null {
	const { tabs, activeTabId } = workspaceStore.getState();
	return tabs.find((t) => t.id === activeTabId) ?? null;
}

export function setTabs(
	next: DocTab[] | ((previous: DocTab[]) => DocTab[]),
): void {
	if (typeof next === "function") {
		workspaceStore.setState((s) => ({ tabs: next(s.tabs) }));
		return;
	}
	workspaceStore.setState({ tabs: next });
}

export function setActiveTabId(id: string | null): void {
	workspaceStore.setState({ activeTabId: id });
}

export function setDockLayout(layout: unknown | null): void {
	workspaceStore.setState({ dockLayout: layout });
}

export function setPdfLru(
	next: string[] | ((previous: string[]) => string[]),
): void {
	if (typeof next === "function") {
		workspaceStore.setState((s) => ({ pdfLru: next(s.pdfLru) }));
		return;
	}
	workspaceStore.setState({ pdfLru: next });
}

export function setEditorLru(
	next: string[] | ((previous: string[]) => string[]),
): void {
	if (typeof next === "function") {
		workspaceStore.setState((s) => ({ editorLru: next(s.editorLru) }));
		return;
	}
	workspaceStore.setState({ editorLru: next });
}

/** Remember closed panels so ⇧⌘T can reopen them (newest last). */
export function pushClosedTabs(entries: readonly ClosedTab[]): void {
	if (!entries.length) return;
	workspaceStore.setState((s) => {
		const paths = new Set(entries.map((entry) => entry.path));
		const kept = s.closedTabs.filter((entry) => !paths.has(entry.path));
		return {
			closedTabs: [...kept, ...entries].slice(-CLOSED_TAB_HISTORY),
		};
	});
}

/** Pop the most recently closed panel (null when the history is empty). */
export function takeClosedTab(): ClosedTab | null {
	const { closedTabs } = workspaceStore.getState();
	const last = closedTabs[closedTabs.length - 1];
	if (!last) return null;
	workspaceStore.setState({ closedTabs: closedTabs.slice(0, -1) });
	return last;
}

/** Drop reopen history (paths belong to the vault being left). */
export function clearClosedTabs(): void {
	if (!workspaceStore.getState().closedTabs.length) return;
	workspaceStore.setState({ closedTabs: [] });
}

/** Merge a patch into the panel with the given id. */
export function updateTab(id: string, patch: Partial<DocTab>): void {
	setTabs((prev) => patchTab(prev, id, patch));
}

export function toggleTabHtmlMode(id: string): void {
	setTabs((prev) =>
		prev.map((tab) => {
			if (
				tab.id !== id ||
				tab.paperMeta?.type === "html" ||
				!tab.htmlUrl ||
				(tab.mode !== "pdf" && tab.mode !== "html")
			) {
				return tab;
			}
			return { ...tab, mode: tab.mode === "pdf" ? "html" : "pdf" };
		}),
	);
}

/** Reseed an open paper tab's NOTES after the reader / download writes it. */
export function refreshTabNotes(paperDir: string, content: string): void {
	setTabs((prev) => seedTabs(prev, paperDir, content, "notes"));
}
