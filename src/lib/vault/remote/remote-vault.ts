/**
 * Remote vault client (SSH/SFTP) — Host commands in `commands/remote.rs`.
 * Design: `docs/development/remote-vault.md`
 */

import type { CatalogEntry, ProbeResult } from "@/lib/agent/api-types";
import { invokeApi } from "@/lib/core/ipc";
import { readJsonStorage, writeJsonStorage } from "@/lib/core/storage";
import { isTauri } from "@/lib/core/tauri";

export type FsCaps = {
	atomicRename: boolean;
	reliableWatch: boolean;
	sqliteNative: boolean;
	cheapRandomRead: boolean;
	agentCwdLocal: boolean;
	finderReveal: boolean;
};

export type RemoteSessionInfo = {
	sessionId: string;
	kind: string;
	displayName: string;
	host: string;
	remotePath: string;
	caps: FsCaps;
	/** Pseudo path: `remote:<sessionId>` */
	vaultHandle: string;
};

export type RemoteDirEntry = {
	name: string;
	isDir: boolean;
	isFile: boolean;
	path: string;
};

const REMOTE_PREFIX = "remote:";

export function isRemoteVaultHandle(path: string | null | undefined): boolean {
	return !!path && path.startsWith(REMOTE_PREFIX);
}

export function remoteSessionIdFromHandle(handle: string): string | null {
	if (!isRemoteVaultHandle(handle)) return null;
	const id = handle.slice(REMOTE_PREFIX.length).trim();
	return id || null;
}

/** Recent-list storage for remote vaults (JSON in localStorage). */
export type RecentRemoteVault = {
	kind: "remote";
	host: string;
	user?: string;
	remotePath: string;
	label: string;
};

const RECENT_REMOTE_KEY = "agentero-recent-remote-vaults";
const MAX_RECENT = 8;

export function getRecentRemoteVaults(): RecentRemoteVault[] {
	const parsed = readJsonStorage<unknown>(RECENT_REMOTE_KEY, []);
	if (!Array.isArray(parsed)) return [];
	return parsed.filter(
		(x): x is RecentRemoteVault =>
			!!x &&
			typeof x === "object" &&
			(x as RecentRemoteVault).kind === "remote" &&
			typeof (x as RecentRemoteVault).host === "string" &&
			typeof (x as RecentRemoteVault).remotePath === "string",
	);
}

export function rememberRecentRemoteVault(entry: RecentRemoteVault): void {
	const key = `${entry.host}\0${entry.user ?? ""}\0${entry.remotePath}`;
	const next = [
		entry,
		...getRecentRemoteVaults().filter(
			(e) => `${e.host}\0${e.user ?? ""}\0${e.remotePath}` !== key,
		),
	].slice(0, MAX_RECENT);
	writeJsonStorage(RECENT_REMOTE_KEY, next);
}

export function removeRecentRemoteVault(entry: RecentRemoteVault): void {
	const key = `${entry.host}\0${entry.user ?? ""}\0${entry.remotePath}`;
	const next = getRecentRemoteVaults().filter(
		(e) => `${e.host}\0${e.user ?? ""}\0${e.remotePath}` !== key,
	);
	writeJsonStorage(RECENT_REMOTE_KEY, next);
}

export async function remoteConnect(args: {
	host: string;
	user?: string;
	remotePath: string;
}): Promise<RemoteSessionInfo> {
	if (!isTauri()) {
		throw new Error("Remote vault requires the desktop app");
	}
	return invokeApi<RemoteSessionInfo>(
		"remote_connect",
		{ args },
		{
			fallback: "Failed to connect remote vault",
		},
	);
}

export type SshConfigHost = {
	alias: string;
	user?: string;
	hostname?: string;
	port?: number;
};

/** Host entries from `~/.ssh/config` for connect-dialog suggestions (#339). */
export async function remoteSshConfigHosts(): Promise<SshConfigHost[]> {
	if (!isTauri()) return [];
	return invokeApi<SshConfigHost[]>("remote_ssh_config_hosts");
}

export type RemoteVaultEnsureResult = {
	path: string;
	created: string[];
	updated: string[];
	openPath: string;
};

/** Seed or safely update bundled skills/onboarding notes in a remote vault. */
export async function remoteEnsureVault(
	sessionId: string,
	locale?: string,
): Promise<RemoteVaultEnsureResult> {
	return invokeApi<RemoteVaultEnsureResult>(
		"remote_vault_ensure",
		{
			args: { sessionId, locale },
		},
		{
			fallback: "Failed to update remote vault skills",
		},
	);
}

export async function remoteDisconnect(sessionId: string): Promise<void> {
	if (!isTauri()) return;
	await invokeApi<null>(
		"remote_disconnect",
		{ args: { sessionId } },
		{
			fallback: "Failed to disconnect",
			allowVoid: true,
		},
	);
}

export async function remoteList(
	sessionId: string,
	path = "",
): Promise<RemoteDirEntry[]> {
	return invokeApi<RemoteDirEntry[]>(
		"remote_list",
		{
			args: { sessionId, path },
		},
		{
			fallback: "Failed to list remote directory",
		},
	);
}

export async function remoteReadText(
	sessionId: string,
	path: string,
): Promise<string> {
	return invokeApi<string>(
		"remote_read_text",
		{ args: { sessionId, path } },
		{
			fallback: "Failed to read remote file",
		},
	);
}

export async function remoteWriteText(
	sessionId: string,
	path: string,
	content: string,
): Promise<void> {
	await invokeApi<null>(
		"remote_write_text",
		{
			args: { sessionId, path, content },
		},
		{
			fallback: "Failed to write remote file",
			allowVoid: true,
		},
	);
}

export async function remoteMkdir(
	sessionId: string,
	path: string,
): Promise<void> {
	await invokeApi<null>(
		"remote_mkdir",
		{ args: { sessionId, path } },
		{
			fallback: "Failed to mkdir",
			allowVoid: true,
		},
	);
}

export async function remoteRemove(
	sessionId: string,
	path: string,
	recursive = true,
): Promise<void> {
	await invokeApi<null>(
		"remote_remove",
		{
			args: { sessionId, path, recursive },
		},
		{
			fallback: "Failed to remove remote path",
			allowVoid: true,
		},
	);
}

export async function remoteWriteBytes(
	sessionId: string,
	path: string,
	data: Uint8Array,
): Promise<void> {
	await invokeApi<null>(
		"remote_write_bytes",
		{
			args: { sessionId, path, data: Array.from(data) },
		},
		{
			fallback: "Failed to write remote bytes",
			allowVoid: true,
		},
	);
}

export async function remotePaperGet(
	sessionId: string,
	args: { path?: string; id?: string },
): Promise<unknown> {
	return invokeApi<unknown>(
		"remote_paper_get",
		{
			args: { sessionId, path: args.path, id: args.id },
		},
		{
			fallback: "Failed to get paper",
		},
	);
}

/** Split `remote:<sessionId>/rel` → `{ sessionId, rel }` or null. */
export function parseRemoteJoinedPath(
	path: string,
): { sessionId: string; rel: string } | null {
	if (!path.startsWith(REMOTE_PREFIX)) return null;
	const slash = path.indexOf("/", REMOTE_PREFIX.length);
	if (slash === -1) {
		const sessionId = path.slice(REMOTE_PREFIX.length).trim();
		return sessionId ? { sessionId, rel: "" } : null;
	}
	const sessionId = path.slice(REMOTE_PREFIX.length, slash).trim();
	if (!sessionId) return null;
	return { sessionId, rel: path.slice(slash + 1) };
}

export async function remotePaperList(sessionId: string): Promise<unknown[]> {
	return invokeApi<unknown[]>(
		"remote_paper_list",
		{ args: { sessionId } },
		{
			fallback: "Failed to list papers",
		},
	);
}

export async function remotePaperRescan(
	sessionId: string,
): Promise<{ count: number }> {
	return invokeApi<{ count: number }>(
		"remote_paper_rescan",
		{
			args: { sessionId },
		},
		{
			fallback: "Failed to rescan",
		},
	);
}

/** Catalog-style scan of common agents on the remote host. */
export type RemoteAgentScanResponse = {
	sessionId: string;
	destination: string;
	entries: CatalogEntry[];
};

export async function remoteAgentScan(
	sessionId: string,
): Promise<RemoteAgentScanResponse> {
	return invokeApi<RemoteAgentScanResponse>(
		"remote_agent_scan",
		{
			args: { sessionId },
		},
		{
			fallback: "Failed to scan remote agents",
		},
	);
}

/** ACP initialize probe for one catalog template on the remote host. */
export async function remoteAgentProbe(
	sessionId: string,
	templateId: string,
): Promise<ProbeResult> {
	return invokeApi<ProbeResult>(
		"remote_agent_probe",
		{
			args: { sessionId, templateId },
		},
		{
			fallback: "Failed to probe remote agent",
		},
	);
}

/**
 * Open Terminal: after Enter, `ssh -t` into the remote host and run the
 * template install command (e.g. Claude ACP adapter via npm). Same confirm UX as local.
 */
export async function remoteAgentOpenInstallTerminal(
	sessionId: string,
	templateId: string,
): Promise<void> {
	await invokeApi<null>(
		"remote_agent_open_install_terminal",
		{
			args: { sessionId, templateId },
		},
		{
			fallback: "Failed to open remote install terminal",
			allowVoid: true,
		},
	);
}

/** Download a remote file into Host cache; returns local absolute path. */
export async function remoteCacheFile(
	sessionId: string,
	path: string,
): Promise<string> {
	const r = await invokeApi<{ localPath: string }>(
		"remote_cache_file",
		{
			args: { sessionId, path },
		},
		{
			fallback: "Failed to cache remote file",
		},
	);
	return r.localPath;
}

export type RemoteCacheStats = {
	bytes: number;
	files: number;
	root: string;
	maxBytes: number;
};

/** Stats for one session (or all remote blob caches when sessionId omitted). */
export async function remoteCacheStats(
	sessionId?: string | null,
): Promise<RemoteCacheStats> {
	return invokeApi<RemoteCacheStats>(
		"remote_cache_stats",
		{
			args: { sessionId: sessionId ?? null },
		},
		{
			fallback: "Failed to read remote cache stats",
		},
	);
}

/** Clear PDF/blob cache for one session or all remote vaults. */
export async function remoteCacheClear(
	sessionId?: string | null,
): Promise<{ freedBytes: number }> {
	return invokeApi<{ freedBytes: number }>(
		"remote_cache_clear",
		{
			args: { sessionId: sessionId ?? null },
		},
		{
			fallback: "Failed to clear remote cache",
		},
	);
}

/** Session-scoped display metadata (not the handle itself). */
const SESSION_META_KEY = "agentero-remote-session-meta";

export function saveRemoteSessionMeta(info: RemoteSessionInfo): void {
	try {
		sessionStorage.setItem(SESSION_META_KEY, JSON.stringify(info));
	} catch {
		// ignore
	}
}

export function getRemoteSessionMeta(): RemoteSessionInfo | null {
	try {
		const raw = sessionStorage.getItem(SESSION_META_KEY);
		if (!raw) return null;
		return JSON.parse(raw) as RemoteSessionInfo;
	} catch {
		return null;
	}
}

export function clearRemoteSessionMeta(): void {
	try {
		sessionStorage.removeItem(SESSION_META_KEY);
	} catch {
		// ignore
	}
}
