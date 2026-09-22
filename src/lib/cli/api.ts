/**
 * CLI install status and PATH shim management (Settings → About).
 * Install may use a local/dev binary or download the same app version from GitHub Releases.
 */

import { commands } from "@/lib/core/bindings";
import { callApi } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { isTauri } from "@/lib/core/tauri";

export type CliInstallStatus = {
	appVersion: string;
	bundledVersion: string | null;
	bundledPath: string | null;
	/** `bundled` | `managed` | `dev` when a binary is resolved */
	source: string | null;
	cliVersion: string | null;
	downloadUrl: string | null;
	releasePageUrl: string;
	canInstall: boolean;
	installed: boolean;
	installPath: string | null;
	shimCurrent: boolean;
	preferredBinDir: string;
	preferredBinOnPath: boolean;
	/** `brew` executable detected (PATH or standard Homebrew roots) */
	brewAvailable: boolean;
	/** Command users type after install (`agentero-cli` on Windows, `agentero` elsewhere) */
	commandName: string;
	message: string | null;
};

export type CliInstallResult = {
	status: CliInstallStatus;
	action: string;
};

export function fetchCliInstallStatus(): Promise<CliInstallStatus> {
	return callApi(() => commands.cliInstallStatus(), {
		fallback: "Failed to read CLI install status",
	});
}

export function installCliCommand(): Promise<CliInstallResult> {
	return callApi(() => commands.cliInstallCommand(), {
		fallback: "Failed to install CLI command",
	});
}

export function uninstallCliCommand(): Promise<CliInstallResult> {
	return callApi(() => commands.cliUninstallCommand(), {
		fallback: "Failed to remove CLI command",
	});
}

export type CliSyncOutcome = "synced" | "skipped";

/**
 * Re-align an already-installed CLI shim with the running app version.
 *
 * The Host downloads and verifies the CLI against the *compiled-in* app
 * version, so the old process cannot pre-install the next CLI during an app
 * update. Instead the fresh app syncs on startup: when the user has a managed
 * CLI entry (`installed`) whose version drifted (`!shimCurrent`), re-run the
 * install so binary + shim match this build. Never throws; callers can retry
 * a transient release-asset/network failure and surface a final failure with
 * a toast. A missing CLI is always skipped: app updates never opt a user into
 * installing a command-line tool they did not previously install.
 */
export async function syncInstalledCliWithApp(): Promise<
	CliSyncOutcome | "failed"
> {
	if (!isTauri() || import.meta.env.DEV) return "skipped";
	let status: CliInstallStatus;
	try {
		status = await fetchCliInstallStatus();
	} catch (error) {
		logger.warn("cli_sync status_read_failed", { error: String(error) });
		return "skipped";
	}
	if (!status.installed || status.shimCurrent || !status.canInstall) {
		return "skipped";
	}
	logger.info("op start cli_sync", {
		from: status.cliVersion ?? "?",
		to: status.appVersion,
	});
	try {
		const result = await installCliCommand();
		logger.info("op end cli_sync ok=true", {
			version: result.status.cliVersion ?? "?",
			action: result.action,
		});
		return "synced";
	} catch (error) {
		logger.warn("op end cli_sync ok=false", { error: String(error) });
		return "failed";
	}
}

export type FinderServiceStatus = {
	/** Quick Action integration exists only on macOS */
	supported: boolean;
	installed: boolean;
	installPath: string | null;
	appBundlePath: string | null;
	/** installed && baked-in bundle matches the current app bundle */
	current: boolean;
	message: string | null;
};

export function fetchFinderServiceStatus(): Promise<FinderServiceStatus> {
	return callApi(() => commands.finderServiceStatus(), {
		fallback: "Failed to read Finder service status",
	});
}

export function installFinderService(): Promise<FinderServiceStatus> {
	return callApi(() => commands.finderServiceInstall(), {
		fallback: "Failed to install Finder service",
	});
}

export function uninstallFinderService(): Promise<FinderServiceStatus> {
	return callApi(() => commands.finderServiceUninstall(), {
		fallback: "Failed to remove Finder service",
	});
}

/** Consume Host-queued vault path from a cold-start deep link (null if none). */
export async function takePendingVaultOpen(): Promise<string | null> {
	if (!isTauri()) return null;
	const res = await commands.vaultOpenTakePending();
	if (!res.ok) return null;
	// `data: null` means no pending path (not a failure).
	return res.data ?? null;
}
