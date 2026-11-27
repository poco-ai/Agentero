/**
 * Identity of the two Dockview containers that can exchange panels.
 *
 * Dockview 7 stores its drag payload in a module-level selection transfer, so
 * a drag started in one container is visible to the other one. The registry is
 * what turns that accidental visibility into intent: only drags started by the
 * counterpart container are accepted.
 */

export type DockTransferSide = "main" | "sidebar";

const dockIds: Partial<Record<DockTransferSide, string>> = {};

/** Register a mounted container; returns its unregister fn. */
export function registerDockTransfer(
	side: DockTransferSide,
	apiId: string,
): () => void {
	dockIds[side] = apiId;
	return () => {
		if (dockIds[side] === apiId) delete dockIds[side];
	};
}

export function dockTransferId(side: DockTransferSide): string | undefined {
	return dockIds[side];
}

/** Which container started a drag, from its Dockview view id. */
export function transferSideOf(
	viewId: string | null | undefined,
): DockTransferSide | null {
	if (!viewId) return null;
	if (viewId === dockIds.main) return "main";
	if (viewId === dockIds.sidebar) return "sidebar";
	return null;
}

/** True when a drop payload comes from the other container. */
export function isCrossDockTransfer(
	data: { viewId?: string } | undefined,
	target: DockTransferSide,
): boolean {
	const side = transferSideOf(data?.viewId);
	return side !== null && side !== target;
}
