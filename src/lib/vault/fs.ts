import { readFile, readTextFile } from "@tauri-apps/plugin-fs";
import i18n from "@/i18n";
import { invokeApi } from "@/lib/core/ipc";
import { isTauri } from "@/lib/core/tauri";
import {
	parseRemoteJoinedPath,
	remoteCacheFile,
	remoteList,
	remoteMkdir,
	remoteReadText,
	remoteRemove,
	remoteWriteBytes,
	remoteWriteText,
} from "@/lib/vault/remote/remote-vault";

export type VaultFileFingerprint = {
	/** Normalized Vault-relative path. */
	path: string;
	size: number;
	/** Modified time in Unix seconds. */
	mtime: number;
	/** Lowercase SHA-256 hex. */
	hash: string;
};

/**
 * Hash a local or remote Vault file entirely inside the Host. Large local
 * files are streamed and their bytes never cross the WebView IPC boundary.
 */
export function fingerprintVaultFile(
	vaultRoot: string,
	vaultRelativePath: string,
): Promise<VaultFileFingerprint> {
	return invokeApi<VaultFileFingerprint>("vault_file_fingerprint", {
		vaultRoot,
		vaultRelativePath,
	});
}

/** Atomically replace one UTF-8 file under a local or remote Vault root. */
export async function writeVaultFileAtomic(
	vaultRoot: string,
	vaultRelativePath: string,
	content: string,
): Promise<void> {
	await invokeApi<null>("vault_write_text_atomic", {
		vaultRoot,
		vaultRelativePath,
		content,
	});
}

/** Materialize a Host-owned read-only local snapshot for an ACP workflow. */
export function createVaultSnapshotWorkspace(
	vaultRoot: string,
	workspaceId: string,
	sourcePaths: string[],
): Promise<string | null> {
	if (!isTauri() || vaultRoot.startsWith("remote:"))
		return Promise.resolve(null);
	return invokeApi<string>("vault_snapshot_workspace_create", {
		vaultRoot,
		workspaceId,
		sourcePaths,
	});
}

/** Release a previously materialized Host-owned snapshot workspace. */
export async function releaseVaultSnapshotWorkspace(
	workspacePath: string,
): Promise<void> {
	if (!isTauri() || !workspacePath) return;
	await invokeApi<null>("vault_snapshot_workspace_release", { workspacePath });
}

export function isMarkdownPath(path: string): boolean {
	return /\.(md|mdx|markdown)$/i.test(path);
}

export function isTextOpenable(path: string): boolean {
	return (
		isMarkdownPath(path) ||
		/\.(txt|json|bib|tex|html?|css|ts|tsx|js|jsx|rs|toml|yaml|yml)$/i.test(path)
	);
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

/** Read a local or remote Vault file into an owned byte array. */
export async function readVaultBytes(path: string): Promise<Uint8Array> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.readDesktopOnly"));
	}

	const remoteRead = parseRemoteJoinedPath(path);
	let bytes: Uint8Array;
	if (remoteRead) {
		if (!remoteRead.rel) throw new Error("invalid remote path");
		const localPath = await remoteCacheFile(
			remoteRead.sessionId,
			remoteRead.rel,
		);
		bytes = await readFile(localPath);
	} else {
		bytes = await readFile(path);
	}
	const copy = new Uint8Array(bytes.byteLength);
	copy.set(bytes);
	return copy;
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

/**
 * Split a vault-relative path into parent dir + basename.
 * Empty `rel` (vault root) returns null.
 */
export function splitVaultRel(
	rel: string,
): { parent: string; name: string } | null {
	const normalized = rel.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
	if (!normalized) return null;
	const slash = normalized.lastIndexOf("/");
	if (slash === -1) return { parent: "", name: normalized };
	return {
		parent: normalized.slice(0, slash),
		name: normalized.slice(slash + 1),
	};
}

/**
 * Whether a local or remote vault path exists.
 *
 * Remote paths (`remote:<sessionId>/…`) must not use `@tauri-apps/plugin-fs`
 * `exists` — those are pseudo-handles outside the local FS scope and would
 * fail (or throw), blocking create on remote vaults (issue #152).
 */
export async function vaultPathExists(path: string): Promise<boolean> {
	if (!isTauri()) {
		throw new Error(i18n.t("app:vault.readDesktopOnly"));
	}

	const remote = parseRemoteJoinedPath(path);
	if (remote) {
		// Open session root always "exists".
		const parts = splitVaultRel(remote.rel);
		if (!parts) return true;
		try {
			const entries = await remoteList(remote.sessionId, parts.parent);
			return entries.some((e) => e.name === parts.name);
		} catch {
			// Missing parent → path does not exist.
			return false;
		}
	}

	const { exists } = await import("@tauri-apps/plugin-fs");
	return exists(path);
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
