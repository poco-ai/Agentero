/**
 * Cross-container panel moves between the main workspace Dockview and the
 * right rail Dockview.
 *
 * Dockview cannot transfer a live panel between two instances, so a move is
 * "open in the destination, then remove the source". Both sides render the
 * same content from the shared stores; the destination is created first, and
 * the source is only removed after the destination exists.
 */

import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { removeTabAnnotations } from "@/lib/pdf/annotations-store";
import { cancelPdfNavigationForTab } from "@/lib/pdf/pending-pdf-page";
import {
	openOrActivateSidebarTarget,
	removeSidebarViewForTransfer,
	type SidebarAgentTarget,
	type SidebarPanelTarget,
	sidebarPanelTarget,
} from "@/lib/shell/sidebar-tabs";
import { uiStore } from "@/lib/shell/ui-store";
import { joinVaultPath } from "@/lib/vault/path";
import { getVaultPath, vaultLoadGeneration } from "@/lib/vault/store";
import { dockHandle } from "@/lib/workspace/dock-registry";
import { openTab } from "@/lib/workspace/navigation";
import { getSidebarDocuments } from "@/lib/workspace/sidebar-documents";
import {
	readSidebarFile,
	type SidebarFileData,
	type SidebarFileTarget,
	sidebarFileTarget,
} from "@/lib/workspace/sidebar-files";
import { currentWindowLabel, getTabs, setTabs } from "@/lib/workspace/store";
import {
	createAgentDockTab,
	type DocTab,
	findCanonicalTab,
	type OpenPlacement,
	type SplitDirection,
	saveWorkspaceLayout,
	tabsAfterMovedView,
} from "@/lib/workspace/tabs";
import { revokeTabMediaSources } from "@/lib/workspace/tabs/resources";
import { flushTextEditorFor } from "@/lib/workspace/text-editor-flush";
import { markdownEditorFor } from "@/lib/workspace/viewer/markdown-editor-registry";

export type DockDropPosition = "left" | "right" | "top" | "bottom" | "center";

type Placement = {
	direction: SplitDirection;
	referencePanelId: string | null;
};

const MODE_BY_TARGET: Record<
	"pdf" | "notes" | "html",
	"pdf" | "markdown" | "html"
> = {
	pdf: "pdf",
	notes: "markdown",
	html: "html",
};

function placementFor(
	position: DockDropPosition,
	referencePanelId: string | null,
): Placement {
	switch (position) {
		case "left":
			return { direction: "left", referencePanelId };
		case "right":
			return { direction: "right", referencePanelId };
		case "top":
			return { direction: "above", referencePanelId };
		case "bottom":
			return { direction: "below", referencePanelId };
		default:
			return { direction: "within", referencePanelId };
	}
}

function toOpenPlacement(placement: Placement): OpenPlacement | null {
	if (!placement.referencePanelId) return null;
	return {
		direction: placement.direction,
		referencePanelId: placement.referencePanelId,
	};
}

/** Whether a main-workspace panel can move to the rail. */
export function canMoveMainPanelToSidebar(viewId: string): boolean {
	const vault = getVaultPath();
	if (!vault) return false;
	const tab = getTabs().find((candidate) => candidate.id === viewId);
	if (!tab) return false;
	const target = sidebarTargetForTab(tab, vault);
	if (!target) return false;
	if (
		target.kind === "agent" &&
		target.scopeId === null &&
		uiStore.getState().agentWindowOpen
	) {
		return false;
	}
	return true;
}

/**
 * A main-workspace tab the rail can host. Mirrors the rail's target kinds:
 * PDF, paper NOTES / Markdown, HTML, and Agent conversations.
 */
export function sidebarTargetForTab(
	tab: DocTab,
	vault: string,
): SidebarPanelTarget | null {
	if (tab.kind === "agent") {
		return {
			kind: "agent",
			scopeId: tab.agentScopeId ?? null,
			...(tab.agentSessionRef ? { sessionRef: tab.agentSessionRef } : {}),
		};
	}
	if (tab.pane || tab.texLive || tab.texRoot || tab.writingRoot) return null;
	if (tab.kind !== "paper" && tab.kind !== "file") return null;
	if (tab.mode !== "pdf" && tab.mode !== "markdown" && tab.mode !== "html") {
		return null;
	}
	const target = sidebarFileTarget(vault, tab.path);
	if (!target) return null;
	// The rail's `notes` target is a Markdown editor in the workspace.
	const expectedMode = target.kind === "notes" ? "markdown" : target.kind;
	return tab.mode === expectedMode ? target : null;
}

async function flushTabDocument(
	viewId: string,
	tab: DocTab | null,
): Promise<boolean> {
	const handle = markdownEditorFor(viewId);
	if (handle?.isDirty()) {
		try {
			if (!(await handle.save())) return false;
		} catch {
			return false;
		}
	} else if (tab && (tab.markdownDirty || tab.notesDirty) && !handle) {
		// Unsaved edits exist but no mounted editor can flush them.
		return false;
	}
	if (tab?.path && !(await flushTextEditorFor(tab.path))) return false;
	return true;
}

/**
 * Write the workspace layout before the rail drops its copy. The dock's own
 * save is debounced; without this, a quit inside that window would lose the
 * moved panel from both snapshots.
 */
function persistMainLayoutNow(): void {
	const vault = getVaultPath();
	const layout = dockHandle()?.snapshotLayout();
	if (vault && layout) {
		saveWorkspaceLayout(currentWindowLabel(), vault, layout);
	}
}

function notifyUnsaved(): void {
	notifyError(i18n.t("app:tabs.moveUnsaved"));
}

function commitMainPanelRemoval(viewId: string): void {
	const removed = getTabs().find((tab) => tab.id === viewId) ?? null;
	setTabs((previous) => tabsAfterMovedView(previous, viewId));
	if (removed) revokeTabMediaSources(removed);
	cancelPdfNavigationForTab(viewId);
	removeTabAnnotations([viewId]);
	dockHandle()?.removePanel(viewId);
}

/** Whether a rail panel can move to the main workspace. */
export function canMoveSidebarPanelToMain(viewId: string): boolean {
	const target = sidebarPanelTarget(viewId);
	if (!target) return false;
	if (target.kind === "launcher" || target.kind === "browser") return false;
	if (target.kind === "agent") return canMoveAgentToMain(target);
	return true;
}

function canMoveAgentToMain(target: SidebarAgentTarget): boolean {
	// The default Agent scope is a singleton surface shared with the Agent
	// window; never host it twice.
	return !(target.scopeId === null && uiStore.getState().agentWindowOpen);
}

function moveAgentToMain(
	target: SidebarAgentTarget,
	placement: Placement,
): boolean {
	if (!canMoveAgentToMain(target)) {
		notifyError(i18n.t("app:tabs.moveAgentWindowOpen"));
		return false;
	}
	const existing = getTabs().find(
		(tab) =>
			tab.kind === "agent" && (tab.agentScopeId ?? null) === target.scopeId,
	);
	if (existing) {
		dockHandle()?.activatePanel(existing.id);
		return true;
	}
	const tab = createAgentDockTab({
		scopeId: target.scopeId,
		sessionRef: target.sessionRef,
		title: target.sessionRef?.title,
	});
	setTabs((previous) => [...previous, tab]);
	const dock = dockHandle();
	dock?.openPanel(tab, toOpenPlacement(placement));
	if (!dock?.canActivatePanel(tab.id)) {
		setTabs((previous) =>
			previous.filter((candidate) => candidate.id !== tab.id),
		);
		notifyError(i18n.t("app:tabs.moveFailed"));
		return false;
	}
	return true;
}

async function moveSidebarFileToMain(
	viewId: string,
	target: SidebarFileTarget,
	placement: Placement,
): Promise<void> {
	const vault = getVaultPath();
	if (!vault) return;
	const path = joinVaultPath(vault, target.vaultRelPath);
	const document =
		getSidebarDocuments().find((tab) => tab.id === viewId) ?? null;
	const generation = vaultLoadGeneration();
	if (!(await flushTabDocument(viewId, document))) {
		notifyUnsaved();
		return;
	}
	if (vaultLoadGeneration() !== generation || getVaultPath() !== vault) return;
	const alreadyOpen = findCanonicalTab(getTabs(), path)?.id ?? null;
	openTab(path, {
		preferMode: MODE_BY_TARGET[target.kind],
		placement: toOpenPlacement(placement) ?? undefined,
		skipDefaultNotes: true,
	});
	// The destination panel is created synchronously as a placeholder; only
	// drop the source once that panel really exists in the dock.
	const opened = findCanonicalTab(getTabs(), path);
	if (!opened || !dockHandle()?.canActivatePanel(opened.id)) {
		// Roll back the placeholder this move just inserted.
		if (!alreadyOpen && opened) {
			setTabs((previous) => tabsAfterMovedView(previous, opened.id));
		}
		return;
	}
	persistMainLayoutNow();
	removeSidebarViewForTransfer(viewId);
}

/**
 * A rail panel was dropped on the main workspace. `position` and the
 * reference panel id come from the destination Dockview's drop event.
 */
export async function moveSidebarPanelToMain(args: {
	panelId: string;
	position: DockDropPosition;
	referencePanelId: string | null;
}): Promise<void> {
	try {
		const target = sidebarPanelTarget(args.panelId);
		if (!target) return;
		const placement = placementFor(args.position, args.referencePanelId);
		if (target.kind === "agent") {
			if (moveAgentToMain(target, placement)) {
				persistMainLayoutNow();
				removeSidebarViewForTransfer(args.panelId);
			}
			return;
		}
		if (target.kind === "launcher" || target.kind === "browser") return;
		await moveSidebarFileToMain(args.panelId, target, placement);
	} catch (error) {
		notifyError(errorText(error));
	}
}

async function sidebarFileData(
	vault: string,
	target: SidebarFileTarget,
): Promise<SidebarFileData | undefined> {
	try {
		return await readSidebarFile(vault, target, {
			allowMissingNotes: target.kind === "notes",
		});
	} catch (error) {
		notifyError(errorText(error));
		return undefined;
	}
}

/**
 * A main-workspace tab was dropped on the rail. The rail is a single group,
 * so the drop position only decides placement inside that group.
 */
export async function moveMainPanelToSidebar(viewId: string): Promise<void> {
	try {
		const vault = getVaultPath();
		if (!vault) return;
		const tab = getTabs().find((candidate) => candidate.id === viewId);
		if (!tab) return;
		const target = sidebarTargetForTab(tab, vault);
		if (!target) return;
		if (!canMoveMainPanelToSidebar(viewId)) {
			if (
				target.kind === "agent" &&
				target.scopeId === null &&
				uiStore.getState().agentWindowOpen
			) {
				notifyError(i18n.t("app:tabs.moveAgentWindowOpen"));
			}
			return;
		}
		const generation = vaultLoadGeneration();
		if (!(await flushTabDocument(viewId, tab))) {
			notifyUnsaved();
			return;
		}
		if (vaultLoadGeneration() !== generation || getVaultPath() !== vault)
			return;

		let file: SidebarFileData | undefined;
		if (
			target.kind === "pdf" ||
			target.kind === "notes" ||
			target.kind === "html"
		) {
			file = await sidebarFileData(vault, target);
			if (!file) return;
		} else if (target.kind !== "agent") {
			return;
		}
		const newViewId = await openOrActivateSidebarTarget(target, { file });
		if (!newViewId) return;
		if (vaultLoadGeneration() !== generation || getVaultPath() !== vault)
			return;
		commitMainPanelRemoval(viewId);
	} catch (error) {
		notifyError(errorText(error));
	}
}
