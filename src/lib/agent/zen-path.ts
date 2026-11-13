/**
 * Virtual center-tab path for Zen, the full-page multi-conversation Agent
 * surface. Virtual only — nothing here ever touches disk.
 *
 * Kept dependency-free so the workspace tab model can route it without
 * pulling the Agent runtime into every document pane.
 */

/** Virtual tree/tab path for the Zen workspace. */
export const ZEN_VIRTUAL_PATH = "agentero:zen";

export function isZenVirtualPath(path: string | null | undefined): boolean {
	return path === ZEN_VIRTUAL_PATH;
}
