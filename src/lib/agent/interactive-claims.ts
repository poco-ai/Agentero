/**
 * One interactive ACP request must surface in exactly one chat panel.
 *
 * When a conversation moves from the right rail to a Zen slot, both surfaces
 * may still receive its stream and permission events (each keeps its own
 * transcript copy). Request ids are unique per prompt, so the first surface to
 * see one claims it; the others drop it.
 */

const claimedRequestIds = new Set<string>();

/** @returns true when this call is the first to claim the request. */
export function claimInteractiveRequest(requestId: string): boolean {
	if (!requestId) return false;
	if (claimedRequestIds.has(requestId)) return false;
	claimedRequestIds.add(requestId);
	return true;
}
