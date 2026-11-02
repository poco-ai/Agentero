import type {
	DockviewApi,
	DockviewDidDropEvent,
	DockviewPanelRenderer,
	DropOverlayModelParams,
	IDockviewPanel,
} from "dockview-react";
import { ensureLibraryTabFirst } from "@/lib/workspace/library-tab-position";
import { isSplitDragPayload } from "@/lib/workspace/tab-dnd";
import {
	type DocTab,
	type OpenPlacement,
	panelPersistParams,
	type ReadingColumns,
	type SplitDirection,
} from "@/lib/workspace/tabs";
import { type CenterViewMode, viewerModeSpec } from "@/lib/workspace/viewer";

/**
 * Map dockview drop Position → addPanel Direction.
 * dockview uses top/bottom; addPanel uses above/below.
 * center → within (same group as a sibling tab).
 */
export function toSplitDirection(
	position: DockviewDidDropEvent["position"],
): SplitDirection {
	if (position === "left") return "left";
	if (position === "top") return "above";
	if (position === "bottom") return "below";
	if (position === "center") return "within";
	return "right";
}

export function isExternalPathDrag(native: DragEvent | PointerEvent): boolean {
	if (!(native instanceof DragEvent) || !native.dataTransfer) return false;
	return isSplitDragPayload(native.dataTransfer);
}

/**
 * True when the drag is a dockview-internal panel/group move (PanelTransfer
 * present). Group drags may have `panelId: null` — still internal. External
 * file-tree path drops return undefined from getData().
 */
export function isInternalDockDrag(getData: () => unknown): boolean {
	return getData() != null;
}

/**
 * Per-target overlay geometry. Content gets a slightly larger edge activation
 * than dockview's 20% default so left/right/above/below splits are easier in
 * wide panels; header void stays generous for "merge as sibling tab".
 */
export function resolveDropOverlayModel({ location }: DropOverlayModelParams):
	| {
			size?: { value: number; type: "percentage" };
			activationSize?: { value: number; type: "percentage" };
	  }
	| undefined {
	if (location === "content") {
		return {
			activationSize: { value: 25, type: "percentage" },
			size: { value: 50, type: "percentage" },
		};
	}
	if (location === "header_space") {
		return {
			activationSize: { value: 50, type: "percentage" },
		};
	}
	// tab / edge: keep dockview defaults (edge shaped by dndEdges).
	return undefined;
}

function resolveReferencePanel(
	api: DockviewApi,
	placement: OpenPlacement,
): string | undefined {
	if (placement?.referencePanelId && api.getPanel(placement.referencePanelId)) {
		return placement.referencePanelId;
	}
	if (api.activePanel?.id) return api.activePanel.id;
	return api.panels[0]?.id;
}

/**
 * dockview panel renderer per mode, declared in the viewer registry: PDF /
 * Markdown / Excalidraw / plain-text / translation panels use
 * `renderer: 'always'` so inactive sibling tabs keep their React shell
 * mounted (enables the App-level LRU keep-alive); HTML / image stay
 * `onlyWhenVisible` to free DOM when not shown.
 */
function rendererForMode(mode: CenterViewMode): DockviewPanelRenderer {
	return viewerModeSpec(mode).renderer;
}

function applyPanelRenderer(panel: IDockviewPanel, mode: CenterViewMode): void {
	const want = rendererForMode(mode);
	if (panel.api.renderer !== want) {
		panel.api.setRenderer(want);
	}
}

export function addPanelWithPlacement(
	api: DockviewApi,
	tab: DocTab,
	placement: OpenPlacement,
	options?: { inactive?: boolean },
): IDockviewPanel {
	const referencePanel = resolveReferencePanel(api, placement);
	const direction = placement?.direction ?? "within";
	return api.addPanel({
		id: tab.id,
		component: "pane",
		// Omit tabComponent so dockview uses its built-in default tab.
		// A string like "default" looks up tabComponents["default"] and throws
		// if not registered (undefined is not a React component).
		title: tab.title,
		params: panelPersistParams(tab),
		renderer: rendererForMode(tab.mode),
		inactive: options?.inactive,
		...(referencePanel
			? {
					position: {
						direction: direction === "within" ? "within" : direction,
						referencePanel,
					},
				}
			: {}),
	});
}

/**
 * Anchors of the standard two-column reading layout: exactly two side-by-side
 * grid groups. Actions use them to keep new papers on the left and NOTES on the
 * right instead of following whichever group happens to hold focus.
 */
export function readingColumnAnchors(
	api: DockviewApi,
	cached?: ReadingColumns | null,
): ReadingColumns | null {
	const groups = api.groups.filter(
		(group) => group.api.location.type === "grid" && group.panels.length > 0,
	);
	const [first, second] = groups;
	if (groups.length !== 2 || !first || !second) return null;
	const a = first.api.boundingBox;
	const b = second.api.boundingBox;
	if (
		a &&
		b &&
		a.width > 0 &&
		b.width > 0 &&
		Math.abs(a.top - b.top) <= 1 &&
		Math.abs(a.height - b.height) <= 1 &&
		Math.abs(a.left - b.left) > 1
	) {
		const left = a.left < b.left ? first : second;
		const right = left === first ? second : first;
		const leftAnchor = left.panels[0];
		const rightAnchor = right.panels[0];
		if (!leftAnchor || !rightAnchor) return null;
		return { leftAnchorId: leftAnchor.id, rightAnchorId: rightAnchor.id };
	}

	// While a group is maximized (e.g. reading layout), hidden groups report width <= 0.
	// If exactly two groups remain and we have cached reading columns whose panels
	// belong to these two groups, keep using the remembered left and right anchors.
	if (api.hasMaximizedGroup() && cached) {
		const firstHasLeft = first.panels.some((p) => p.id === cached.leftAnchorId);
		const secondHasRight = second.panels.some(
			(p) => p.id === cached.rightAnchorId,
		);
		if (firstHasLeft && secondHasRight) {
			return {
				leftAnchorId: first.panels[0]?.id ?? cached.leftAnchorId,
				rightAnchorId: second.panels[0]?.id ?? cached.rightAnchorId,
			};
		}
		const firstHasRight = first.panels.some(
			(p) => p.id === cached.rightAnchorId,
		);
		const secondHasLeft = second.panels.some(
			(p) => p.id === cached.leftAnchorId,
		);
		if (firstHasRight && secondHasLeft) {
			return {
				leftAnchorId: second.panels[0]?.id ?? cached.leftAnchorId,
				rightAnchorId: first.panels[0]?.id ?? cached.rightAnchorId,
			};
		}
	}

	return null;
}

export function rebalanceGridGroupWidths(api: DockviewApi): void {
	const groups = api.groups.filter(
		(group) => group.api.location.type === "grid",
	);
	if (groups.length < 2 || api.width <= 0) return;
	const width = Math.max(1, Math.floor(api.width / groups.length));
	for (const group of groups) {
		group.api.setSize({ width });
	}
}

/** Remove grid groups that ended up with no panels (e.g. persisted empty split). */
function compactEmptyGroups(api: DockviewApi): void {
	const gridGroups = api.groups.filter(
		(group) => group.api.location.type === "grid",
	);
	if (gridGroups.length < 2) return;
	if (!gridGroups.some((group) => group.panels.length > 0)) return;

	let changed = false;
	for (const group of gridGroups) {
		if (group.panels.length === 0) {
			try {
				api.removeGroup(group);
				changed = true;
			} catch {
				// ignore: dockview may refuse to remove a locked group
			}
		}
	}
	if (changed) {
		rebalanceGridGroupWidths(api);
	}
}

/** Push React tab title / persist params / renderer onto an existing dockview panel. */
export function applyTabPanelMeta(panel: IDockviewPanel, tab: DocTab): void {
	if (panel.title !== tab.title) {
		panel.api.setTitle(tab.title);
	}
	panel.api.updateParameters(panelPersistParams(tab));
	applyPanelRenderer(panel, tab.mode);
}

/**
 * Align dockview panel membership with React `tabs[]`:
 * drop stale panels, add missing ones (default placement).
 */
export function reconcilePanelMembership(
	api: DockviewApi,
	list: DocTab[],
): void {
	const wantIds = new Set(list.map((t) => t.id));
	for (const panel of [...api.panels]) {
		if (!wantIds.has(panel.id)) {
			api.removePanel(panel);
		}
	}
	for (const tab of list) {
		if (api.getPanel(tab.id)) continue;
		addPanelWithPlacement(api, tab, null);
	}
	compactEmptyGroups(api);
	ensureLibraryTabFirst(api);
}

/**
 * After fromJSON restore: refresh meta for surviving panels, then membership.
 */
export function reconcileAfterLayoutRestore(
	api: DockviewApi,
	list: DocTab[],
): void {
	for (const tab of list) {
		const panel = api.getPanel(tab.id);
		if (!panel) continue;
		// Always re-apply: fromJSON may restore older title/params/renderer.
		panel.api.setTitle(tab.title);
		panel.api.updateParameters(panelPersistParams(tab));
		applyPanelRenderer(panel, tab.mode);
	}
	reconcilePanelMembership(api, list);
}

export function visiblePanelIds(api: DockviewApi): string[] {
	return api.groups.flatMap((group) =>
		group.activePanel ? [group.activePanel.id] : [],
	);
}
