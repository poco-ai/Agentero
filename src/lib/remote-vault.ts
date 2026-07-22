/**
 * Remote vault client (SSH/SFTP) — Host commands in `commands/remote.rs`.
 * Design: `docs/development/remote-vault.md`
 */

import { ipc } from "@/lib/ipc";
import { isTauri } from "@/lib/tauri";

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
	try {
		const raw = localStorage.getItem(RECENT_REMOTE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		return parsed.filter(
			(x): x is RecentRemoteVault =>
				!!x &&
				typeof x === "object" &&
				(x as RecentRemoteVault).kind === "remote" &&
				typeof (x as RecentRemoteVault).host === "string" &&
				typeof (x as RecentRemoteVault).remotePath === "string",
		);
	} catch {
		return [];
	}
}

export function rememberRecentRemoteVault(entry: RecentRemoteVault): void {
	try {
		const key = `${entry.host}\0${entry.user ?? ""}\0${entry.remotePath}`;
		const next = [
			entry,
			...getRecentRemoteVaults().filter(
				(e) => `${e.host}\0${e.user ?? ""}\0${e.remotePath}` !== key,
			),
		].slice(0, MAX_RECENT);
		localStorage.setItem(RECENT_REMOTE_KEY, JSON.stringify(next));
	} catch {
		// ignore
	}
}

export function removeRecentRemoteVault(entry: RecentRemoteVault): void {
	try {
		const key = `${entry.host}\0${entry.user ?? ""}\0${entry.remotePath}`;
		const next = getRecentRemoteVaults().filter(
			(e) => `${e.host}\0${e.user ?? ""}\0${e.remotePath}` !== key,
		);
		localStorage.setItem(RECENT_REMOTE_KEY, JSON.stringify(next));
	} catch {
		// ignore
	}
}

export async function remoteConnect(args: {
	host: string;
	user?: string;
	remotePath: string;
}): Promise<RemoteSessionInfo> {
	if (!isTauri()) {
		throw new Error("Remote vault requires the desktop app");
	}
	return ipc<RemoteSessionInfo>("remote_connect", { args });
}

export type RemoteVaultEnsureResult = {
	path: string;
	created: string[];
	openPath: string;
};

/** Seed missing bundled skills in the connected remote vault. */
export async function remoteEnsureVault(
	sessionId: string,
): Promise<RemoteVaultEnsureResult> {
	return ipc<RemoteVaultEnsureResult>("remote_vault_ensure", {
		args: { sessionId },
	});
}

export async function remoteDisconnect(sessionId: string): Promise<void> {
	if (!isTauri()) return;
	await ipc<null>("remote_disconnect", {
		args: { sessionId },
	});
}

export async function remoteList(
	sessionId: string,
	path = "",
): Promise<RemoteDirEntry[]> {
	return ipc<RemoteDirEntry[]>("remote_list", {
		args: { sessionId, path },
	});
}

export async function remoteReadText(
	sessionId: string,
	path: string,
): Promise<string> {
	return ipc<string>("remote_read_text", {
		args: { sessionId, path },
	});
}

export async function remoteWriteText(
	sessionId: string,
	path: string,
	content: string,
): Promise<void> {
	await ipc<null>("remote_write_text", {
		args: { sessionId, path, content },
	});
}

export async function remoteReadBytes(
	sessionId: string,
	path: string,
): Promise<Uint8Array> {
	const data = await ipc<number[]>("remote_read_bytes", {
		args: { sessionId, path },
	});
	return new Uint8Array(data);
}

export async function remoteMkdir(
	sessionId: string,
	path: string,
): Promise<void> {
	await ipc<null>("remote_mkdir", {
		args: { sessionId, path },
	});
}

export async function remoteRemove(
	sessionId: string,
	path: string,
	recursive = true,
): Promise<void> {
	await ipc<null>("remote_remove", {
		args: { sessionId, path, recursive },
	});
}

export async function remoteWriteBytes(
	sessionId: string,
	path: string,
	data: Uint8Array,
): Promise<void> {
	await ipc<null>("remote_write_bytes", {
		args: { sessionId, path, data: Array.from(data) },
	});
}

export async function remotePaperGet(
	sessionId: string,
	args: { path?: string; id?: string },
): Promise<unknown> {
	return ipc<unknown>("remote_paper_get", {
		args: { sessionId, path: args.path, id: args.id },
	});
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
	return ipc<unknown[]>("remote_paper_list", {
		args: { sessionId },
	});
}

export async function remotePaperRescan(
	sessionId: string,
): Promise<{ count: number }> {
	return ipc<{ count: number }>("remote_paper_rescan", {
		args: { sessionId },
	});
}

export async function remoteAgentDiscover(sessionId: string): Promise<{
	destination: string;
	found: { bin: string; path: string }[];
}> {
	return ipc<{ destination: string; found: { bin: string; path: string }[] }>(
		"remote_agent_discover",
		{
			args: { sessionId, bins: [] },
		},
	);
}

/** Catalog-style scan of common agents on the remote host. */
export type RemoteAgentScanResponse = {
	sessionId: string;
	destination: string;
	entries: import("@/lib/agent").CatalogEntry[];
};

export async function remoteAgentScan(
	sessionId: string,
): Promise<RemoteAgentScanResponse> {
	return ipc<RemoteAgentScanResponse>("remote_agent_scan", {
		args: { sessionId },
	});
}

/** ACP initialize probe for one catalog template on the remote host. */
export async function remoteAgentProbe(
	sessionId: string,
	templateId: string,
): Promise<import("@/lib/agent").ProbeResult> {
	return ipc<import("@/lib/agent").ProbeResult>("remote_agent_probe", {
		args: { sessionId, templateId },
	});
}

/**
 * Open Terminal: after Enter, `ssh -t` into the remote host and run the
 * template install command (e.g. Claude ACP adapter via npm). Same confirm UX as local.
 */
export async function remoteAgentOpenInstallTerminal(
	sessionId: string,
	templateId: string,
): Promise<void> {
	await ipc<null>("remote_agent_open_install_terminal", {
		args: { sessionId, templateId },
	});
}

export type HostOsKind = "macos" | "windows" | "linux" | "other";

export type HostIdentity = {
	hostname: string;
	label: string;
	/** Guest OS family for brand icon. */
	os: HostOsKind | string;
};

/** Local machine hostname for Settings host badge. */
export async function fetchHostIdentity(): Promise<HostIdentity> {
	return ipc<HostIdentity>("host_identity");
}

export type RemoteHostIdentity = {
	sessionId: string;
	destination: string;
	os: HostOsKind | string;
	uname: string;
};

/** Remote OS family (`uname -s`) for Settings host badge. */
export async function fetchRemoteHostIdentity(
	sessionId: string,
): Promise<RemoteHostIdentity> {
	return ipc<RemoteHostIdentity>("remote_host_identity", {
		args: { sessionId },
	});
}

/** Download a remote file into Host cache; returns local absolute path. */
export async function remoteCacheFile(
	sessionId: string,
	path: string,
): Promise<string> {
	const r = await ipc<{ localPath: string }>("remote_cache_file", {
		args: { sessionId, path },
	});
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
	return ipc<RemoteCacheStats>("remote_cache_stats", {
		args: { sessionId: sessionId ?? null },
	});
}

/** Clear PDF/blob cache for one session or all remote vaults. */
export async function remoteCacheClear(
	sessionId?: string | null,
): Promise<{ freedBytes: number }> {
	return ipc<{ freedBytes: number }>("remote_cache_clear", {
		args: { sessionId: sessionId ?? null },
	});
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
