import type { Update } from "@tauri-apps/plugin-updater";
import i18n from "@/i18n";
import { errorText } from "@/lib/core/error";
import { logger } from "@/lib/core/logger";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { notifyReleaseDownloadError } from "@/lib/settings/download-error";
import { ensureSettingsLoaded } from "@/lib/settings/store";
import type { UpdateSnapshot } from "@/lib/update/types";

const UNSUPPORTED: UpdateSnapshot = { phase: "unsupported" };

let snapshot: UpdateSnapshot = isUpdaterSupported()
	? { phase: "idle" }
	: UNSUPPORTED;
let availableUpdate: Update | null = null;
let checkPromise: Promise<UpdateSnapshot> | null = null;
let installPromise: Promise<UpdateSnapshot> | null = null;
const listeners = new Set<(next: UpdateSnapshot) => void>();

function isUpdaterSupported(): boolean {
	return isTauri() && !import.meta.env.DEV;
}

/**
 * Settings → General → network proxy, which the updater plugin would otherwise
 * ignore: it ships its own reqwest client instead of Host `network::client_builder`.
 * When the app proxy is off, fall back to the OS system proxy detected by the
 * Host (Windows "Internet Settings") — same fallback Host requests use.
 */
async function resolveProxyUrl(): Promise<string | undefined> {
	const settings = await ensureSettingsLoaded();
	let url: string | undefined;
	if (settings.networkProxyEnabled) {
		url = settings.networkProxyUrl.trim() || undefined;
	} else {
		try {
			const { callApi } = await import("@/lib/core/ipc");
			const { commands } = await import("@/lib/core/bindings");
			url = (await callApi(() => commands.networkSystemProxy())) ?? undefined;
		} catch {
			url = undefined;
		}
	}
	if (!url) return undefined;
	// The plugin's client has no SOCKS support, so forwarding such a URL would
	// fail every check — even where a direct connection still works.
	if (!/^https?:\/\//i.test(url)) {
		logger.warn(`updater_check proxy_unsupported scheme=${url.split(":")[0]}`);
		return undefined;
	}
	return url;
}

async function requestUpdate(
	proxy: string | undefined,
	retryOnTimeout = false,
): Promise<Update | null> {
	const { callResult } = await import("@/lib/core/ipc");
	const { commands } = await import("@/lib/core/bindings");
	const { Update } = await import("@tauri-apps/plugin-updater");
	const metadata = await callResult(() =>
		commands.appUpdateCheck(proxy ?? null, retryOnTimeout),
	);
	if (!metadata) return null;

	return new Update({
		...metadata,
		body: metadata.body ?? undefined,
		// The complete manifest is held by the native updater resource.
		rawJson: {},
	});
}

function emit(next: UpdateSnapshot): UpdateSnapshot {
	snapshot = next;
	for (const listener of listeners) listener(snapshot);
	return snapshot;
}

async function closeUpdate(update: Update): Promise<void> {
	try {
		await update.close();
	} catch {
		// The native resource may already have been released by a failed download.
	}
}

async function closeAvailableUpdate(): Promise<void> {
	const update = availableUpdate;
	availableUpdate = null;
	if (!update) return;
	await closeUpdate(update);
}

function compareVersions(a: string, b: string): number {
	const left = a.split(".").map((part) => Number.parseInt(part, 10) || 0);
	const right = b.split(".").map((part) => Number.parseInt(part, 10) || 0);
	for (let i = 0; i < Math.max(left.length, right.length); i++) {
		const diff = (left[i] ?? 0) - (right[i] ?? 0);
		if (diff !== 0) return diff;
	}
	return 0;
}

async function refreshStaleUpdate(cached: Update): Promise<Update> {
	let latest: Update | null = null;
	try {
		latest = await requestUpdate(await resolveProxyUrl());
	} catch {
		return cached;
	}
	if (!latest || compareVersions(latest.version, cached.version) <= 0) {
		if (latest) await closeUpdate(latest);
		return cached;
	}
	availableUpdate = latest;
	await closeUpdate(cached);
	logger.info("updater_install refresh", {
		from: cached.version,
		to: latest.version,
	});
	return latest;
}

export function getUpdateSnapshot(): UpdateSnapshot {
	return { ...snapshot };
}

export function subscribeUpdate(
	listener: (next: UpdateSnapshot) => void,
): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/**
 * Queries the signed updater endpoint. It never throws so a background check
 * cannot affect application startup; callers render the returned state instead.
 */
export async function checkForUpdate({
	retryOnTimeout = false,
}: {
	retryOnTimeout?: boolean;
} = {}): Promise<UpdateSnapshot> {
	if (!isUpdaterSupported()) return emit(UNSUPPORTED);
	if (checkPromise) return checkPromise;

	checkPromise = (async () => {
		await closeAvailableUpdate();
		emit({ phase: "checking" });
		try {
			const proxy = await resolveProxyUrl();
			logger.info(`op start updater_check proxy=${proxy ? "on" : "off"}`);
			// The returned Update carries this proxy into the later download.
			const update = await requestUpdate(proxy, retryOnTimeout);
			if (!update) {
				logger.info("op end updater_check ok=true available=false");
				return emit({ phase: "up-to-date" });
			}
			availableUpdate = update;
			logger.info("op end updater_check ok=true available=true", {
				version: update.version,
			});
			return emit({
				phase: "available",
				currentVersion: update.currentVersion,
				availableVersion: update.version,
				notes: update.body,
			});
		} catch (error) {
			logger.warn("op end updater_check ok=false", {
				error: errorText(error),
			});
			return emit({ phase: "error", errorOperation: "check" });
		} finally {
			checkPromise = null;
		}
	})();

	return checkPromise;
}

/** Downloads the verified updater package, installs it, then restarts the app. */
export async function installAvailableUpdate(): Promise<UpdateSnapshot> {
	if (!isUpdaterSupported()) return emit(UNSUPPORTED);
	if (installPromise) return installPromise;
	if (!availableUpdate) {
		notifyError(i18n.t("settings:about.update.installFailed"));
		return emit({ phase: "error", errorOperation: "install" });
	}

	const cached = availableUpdate;
	installPromise = (async () => {
		emit({
			phase: "downloading",
			currentVersion: cached.currentVersion,
			availableVersion: cached.version,
			notes: cached.body,
			downloadedBytes: 0,
		});
		// The cached manifest can be days old when the app stayed open across
		// releases (#481); re-check so users always install the latest version.
		const update = await refreshStaleUpdate(cached);
		logger.info("op start updater_install", { version: update.version });
		let downloadedBytes = 0;
		let totalBytes: number | undefined;
		if (update !== cached) {
			emit({
				phase: "downloading",
				currentVersion: update.currentVersion,
				availableVersion: update.version,
				notes: update.body,
				downloadedBytes,
			});
		}
		let downloading = true;
		try {
			await update.download((event) => {
				if (event.event === "Started") {
					totalBytes = event.data.contentLength;
				} else if (event.event === "Progress") {
					downloadedBytes += event.data.chunkLength;
				}
				emit({
					phase: "downloading",
					currentVersion: update.currentVersion,
					availableVersion: update.version,
					notes: update.body,
					downloadedBytes,
					totalBytes,
				});
			});
			downloading = false;
			emit({
				phase: "installing",
				currentVersion: update.currentVersion,
				availableVersion: update.version,
				notes: update.body,
			});
			await update.install();
			logger.info("op end updater_install ok=true", {
				version: update.version,
			});
			const { relaunch } = await import("@tauri-apps/plugin-process");
			await relaunch();
			return getUpdateSnapshot();
		} catch (error) {
			logger.error("op end updater_install ok=false", {
				version: update.version,
				error: errorText(error),
			});
			const message = i18n.t("settings:about.update.installFailed");
			if (downloading) {
				notifyReleaseDownloadError(message, error);
			} else {
				notifyError(message);
			}
			await closeAvailableUpdate();
			return emit({ phase: "error", errorOperation: "install" });
		} finally {
			installPromise = null;
		}
	})();

	return installPromise;
}
