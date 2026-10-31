/**
 * Pure Node.js readiness rules for Agent lifecycle actions.
 *
 * The bundled ACP adapters and the separate `*-acp` adapters are JavaScript
 * packages: installing them runs npm and running them spawns
 * `node <dist/index.js>`. A few host CLIs are npm-only as well (Dsh, MiniMax
 * Code, MiMo Code everywhere; OpenCode on Windows, where it has no native
 * installer). Without Node.js/npm those lifecycle actions cannot succeed, so
 * the Agent pane guides the user to install Node.js first instead of starting
 * a doomed background install (Fix #786).
 *
 * Native ACP CLIs with a platform installer (Hermes, Qoder, Kimi, Grok,
 * Antigravity, ...) are left alone: their catalog wire format does not say
 * whether a given platform falls back to npm, so their actions keep today's
 * behavior (the failure toast already offers the same one-click Node install).
 */

import type { CatalogEntry, ToolLifecycleAction } from "@/lib/agent";
import { getPlatformOS } from "@/lib/core/tauri";

/** Catalog fields that decide whether an action runs through Node.js. */
export type NodeDependentEntry = Pick<
	CatalogEntry,
	"adapterDistinct" | "acpBundled" | "templateId"
>;

/** Host Node.js/npm availability, from `doctor_check_host`. */
export type HostNodeGap = {
	nodeMissing: boolean;
	npmMissing: boolean;
};

/** Host CLIs whose install/update is `npm i -g …` on every platform. */
const NPM_ONLY_TEMPLATE_IDS = new Set(["dsh", "minimax-code", "mimo-code"]);

/** Host CLIs that fall back to npm only on Windows (no native installer). */
const WINDOWS_NPM_ONLY_TEMPLATE_IDS = new Set(["opencode"]);

export type PlatformOS = ReturnType<typeof getPlatformOS>;

/**
 * Official Node.js download page: the manual route that works when no system
 * package manager (winget / Homebrew) can install Node.js (#859).
 */
export const NODE_DOWNLOAD_URL = "https://nodejs.org/en/download";

/**
 * True when this install/update runs through Node.js/npm:
 * - `adapterDistinct`: the ACP layer is a separate adapter, and every adapter
 *   supported by the lifecycle (Claude / Codex / Pi / ZCode) is an npm package
 *   that Node executes;
 * - `acpBundled`: the bundled JS adapter tier has the same runtime requirement
 *   even though the files ship with the app;
 * - npm-only host CLIs (see the module comment).
 * Uninstall can also run `npm uninstall` for these templates, but a missing
 * npm must never block removing an Agent (it is the recovery path), so it is
 * deliberately excluded.
 */
export function lifecycleNeedsNode(
	entry: NodeDependentEntry,
	action: ToolLifecycleAction,
	platform: PlatformOS = getPlatformOS(),
): boolean {
	if (action === "uninstall") return false;
	if (entry.adapterDistinct || entry.acpBundled) return true;
	if (NPM_ONLY_TEMPLATE_IDS.has(entry.templateId)) return true;
	return (
		platform === "windows" &&
		WINDOWS_NPM_ONLY_TEMPLATE_IDS.has(entry.templateId)
	);
}

/**
 * True when `entry`'s `action` would fail immediately because this host has no
 * usable Node.js/npm. `host` is null until the first `doctor_check_host`
 * resolves; an unknown host never blocks, so the buttons keep their pre-#786
 * behavior (failure toast with the Node install recovery) instead of a state
 * we cannot verify.
 */
export function isLifecycleNodeBlocked(
	entry: NodeDependentEntry,
	action: ToolLifecycleAction,
	host: HostNodeGap | null,
): boolean {
	if (!host || (!host.nodeMissing && !host.npmMissing)) return false;
	return lifecycleNeedsNode(entry, action);
}
