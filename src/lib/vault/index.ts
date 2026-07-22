/**
 * Vault filesystem facade.
 *
 * Dispatches between the local filesystem (`./local`, Tauri plugin-fs / ipc)
 * and remote SSH/SFTP transport (`./remote` + `@/lib/remote-vault`) based on
 * the vault root handle (`isRemoteVaultHandle` / `parseRemoteJoinedPath`). Pure
 * types + path helpers live in `./types`; path persistence in `./session`.
 */

import { readTextFile } from "@tauri-apps/plugin-fs";

import i18n from "@/i18n";
import { ipc } from "@/lib/ipc";
import {
	getRemoteSessionMeta,
	isRemoteVaultHandle,
	parseRemoteJoinedPath,
	remoteEnsureVault,
	remoteMkdir,
	remoteReadText,
	remoteRemove,
	remoteSessionIdFromHandle,
	remoteWriteBytes,
	remoteWriteText,
} from "@/lib/remote-vault";
import { isTauri } from "@/lib/tauri";
import { buildTreeLocal } from "@/lib/vault/local";
import { buildTreeRemote } from "@/lib/vault/remote";
import {
	type CreateVaultResult,
	type FileNode,
	remoteRelFromJoined,
} from "@/lib/vault/types";

export {
	createVault,
	pickCreateVaultDirectory,
	pickVaultDirectory,
} from "@/lib/vault/local";
export * from "@/lib/vault/session";
export * from "@/lib/vault/types";

/** Open a new Agentero window without restoring a vault (desktop only). */
export async function openNewWindow(): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.openDesktopOnly"));
	}
	await ipc<null>("window_new");
}

/**
 * List one directory level only (used when expanding a lazy folder).
 * Nested directories stay `childrenPending` (expand again to go deeper).
 */
export async function listVaultDirChildren(
	rootPath: string,
	dirAbsPath: string,
): Promise<FileNode[]> {
	if (isRemoteVaultHandle(rootPath)) {
		const sessionId = remoteSessionIdFromHandle(rootPath);
		if (!sessionId) return [];
		const rel = remoteRelFromJoined(rootPath, dirAbsPath);
		// Expanding a non-eager folder: only one more level; subdirs stay pending.
		return buildTreeRemote(rootPath, rel, 0, true);
	}
	// Local: dirAbsPath is absolute; rel only used for eager checks (disabled here).
	return buildTreeLocal(dirAbsPath, "", 0, true);
}

/**
 * Build the vault file tree.
 *
 * - Eager recursive: `papers/`, `notes/`, `plans/`, `.agents/`
 * - Shallow elsewhere: vault-root extras (`src/`, `thesis/`, …) appear as
 *   one level with `childrenPending`; expand via {@link listVaultDirChildren}.
 * - Ignored names ({@link TREE_IGNORE_NAMES} / dots / `*.egg-info`) are never listed.
 */
export async function loadVaultTree(rootPath: string): Promise<FileNode[]> {
	if (isRemoteVaultHandle(rootPath)) {
		return buildTreeRemote(rootPath, "");
	}
	return buildTreeLocal(rootPath, "");
}

/**
 * Idempotent ensure for an open vault (Host: vault_ensure).
 * Seeds any **missing** bundled skills under `.agents/skills/` after app updates;
 * never overwrites user-edited skill files. Safe to call on every open.
 */
export async function ensureVault(path: string): Promise<CreateVaultResult> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.createDesktopOnly"));
	}

	const { logOp } = await import("@/lib/logger");
	return logOp("ensureVault", { path }, async () => {
		const remoteSessionId = remoteSessionIdFromHandle(path);
		if (remoteSessionId) {
			return remoteEnsureVault(remoteSessionId);
		}
		return ipc<CreateVaultResult>("vault_ensure", { path });
	});
}

/**
 * Probe an existing vault dir and grant it to the webview fs scope
 * (Host: vault_authorize; persisted across restarts). Never creates
 * directories — safe as an existence check for restore/recent flows.
 * Remote vault handles bypass plugin-fs and are always authorized.
 */
export async function authorizeVault(path: string): Promise<boolean> {
	if (!isTauri()) return false;
	if (remoteSessionIdFromHandle(path)) return true;
	return ipc<boolean>("vault_authorize", { path });
}

export async function readVaultFile(path: string): Promise<string> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.readDesktopOnly"));
	}

	const remoteRead = parseRemoteJoinedPath(path);
	if (remoteRead) {
		if (!remoteRead.rel) throw new Error("invalid remote path");
		return remoteReadText(remoteRead.sessionId, remoteRead.rel);
	}

	return readTextFile(path);
}

/** Write text file (creates parent dirs when possible). */
export async function writeVaultFile(
	path: string,
	content: string,
): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}

	const remoteWrite = parseRemoteJoinedPath(path);
	if (remoteWrite) {
		if (!remoteWrite.rel) throw new Error("invalid remote path");
		await remoteWriteText(remoteWrite.sessionId, remoteWrite.rel, content);
		return;
	}

	const { mkdir, writeTextFile } = await import("@tauri-apps/plugin-fs");
	const parent = path.replace(/[\\/][^\\/]+$/, "");
	if (parent && parent !== path) {
		try {
			await mkdir(parent, { recursive: true });
		} catch {
			// Parent may already exist
		}
	}
	await writeTextFile(path, content);
}

/** Write binary file (creates parent dirs when possible). Used for Markdown `./assets/` images. */
export async function writeVaultBytes(
	path: string,
	bytes: Uint8Array,
): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}

	const remote = parseRemoteJoinedPath(path);
	if (remote) {
		if (!remote.rel) throw new Error("invalid remote path");
		await remoteWriteBytes(remote.sessionId, remote.rel, bytes);
		return;
	}

	const { mkdir, writeFile } = await import("@tauri-apps/plugin-fs");
	const parent = path.replace(/[\\/][^\\/]+$/, "");
	if (parent && parent !== path) {
		try {
			await mkdir(parent, { recursive: true });
		} catch {
			// Parent may already exist
		}
	}
	await writeFile(path, bytes);
}

/** Create a directory (and parents) under the vault. */
export async function createVaultDirectory(path: string): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}

	const remote = parseRemoteJoinedPath(path);
	if (remote) {
		if (!remote.rel) throw new Error("invalid remote path");
		await remoteMkdir(remote.sessionId, remote.rel);
		return;
	}

	const { mkdir } = await import("@tauri-apps/plugin-fs");
	await mkdir(path, { recursive: true });
}

/**
 * Remove a file or directory under the vault.
 * Directories are removed recursively (including non-empty).
 * Remote vaults use SFTP remove (no recycle bin in MVP).
 */
export async function removeVaultPath(path: string): Promise<void> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.writeDesktopOnly"));
	}
	const trimmed = path.trim();
	if (!trimmed || trimmed.startsWith("agentero:")) {
		throw new Error(i18n.t("sidebar:fileTree.deleteInvalid"));
	}
	const remote = parseRemoteJoinedPath(trimmed);
	if (remote) {
		if (!remote.rel) throw new Error("invalid remote path");
		await remoteRemove(remote.sessionId, remote.rel, true);
		return;
	}
	const { remove } = await import("@tauri-apps/plugin-fs");
	await remove(trimmed, { recursive: true });
}

export function vaultDisplayName(rootPath: string | null): string {
	if (!rootPath) return i18n.t("app:vault.noVaultName");
	if (isRemoteVaultHandle(rootPath)) {
		const meta = getRemoteSessionMeta();
		if (meta?.displayName) return meta.displayName;
		return rootPath;
	}
	const parts = rootPath.replace(/[\\/]+$/, "").split(/[\\/]/);
	return parts[parts.length - 1] || rootPath;
}
