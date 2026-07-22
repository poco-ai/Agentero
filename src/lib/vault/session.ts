/**
 * Vault path persistence: per-window session binding, durable "last / recent
 * local vaults", and the "restore last vault" resolution. Remote handles
 * (`remote:<sessionId>`) are ephemeral and never written to the durable lists.
 */

/** Per-window vault (sessionStorage — isolated across ⌘N windows). */
const SESSION_VAULT_KEY = "agentero-vault-path";
/** Last opened vault for "restore last vault" on the primary window. */
const LAST_VAULT_KEY = "agentero-vault-path";
/** MRU list for welcome screen (localStorage, shared). */
const RECENT_VAULTS_KEY = "agentero-recent-vaults";
const MAX_RECENT_VAULTS = 8;

/**
 * Remote vault handles (`remote:<sessionId>`) are ephemeral: a new UUID is
 * issued on every SSH connect. They must not pollute the durable "recent local
 * vaults" list or "restore last vault" — remote recents live in
 * `agentero-recent-remote-vaults` (host + remotePath).
 */
function isEphemeralRemoteHandle(path: string): boolean {
	return path.startsWith("remote:");
}

/** True when this window was opened via ⌘N / New Window (`?fresh=1`). */
export function isFreshWindow(): boolean {
	try {
		return new URLSearchParams(window.location.search).get("fresh") === "1";
	} catch {
		return false;
	}
}

export function getSessionVaultPath(): string | null {
	try {
		return sessionStorage.getItem(SESSION_VAULT_KEY);
	} catch {
		return null;
	}
}

/** Last vault path (localStorage) — used when restore-last is enabled. */
export function getLastVaultPath(): string | null {
	try {
		const last = localStorage.getItem(LAST_VAULT_KEY);
		// Drop stale remote handles left by older builds (session no longer exists).
		if (last && isEphemeralRemoteHandle(last)) return null;
		return last;
	} catch {
		return null;
	}
}

/**
 * Resolve initial vault for this window:
 * 1. Session path if already chosen in this window
 * 2. Never auto-open on fresh (⌘N) windows
 * 3. Otherwise last vault when caller enables restore
 */
export function getSavedVaultPath(opts?: {
	allowRestore?: boolean;
}): string | null {
	const session = getSessionVaultPath();
	// Keep whatever this window already opened (incl. live `remote:<id>` handle).
	if (session) return session;
	if (isFreshWindow()) return null;
	if (opts?.allowRestore === false) return null;
	// Cross-launch restore: local path only (remote needs SSH re-connect).
	return getLastVaultPath();
}

export function getRecentVaults(): string[] {
	try {
		const raw = localStorage.getItem(RECENT_VAULTS_KEY);
		if (!raw) {
			// Migrate single last-vault into recents once.
			const last = getLastVaultPath();
			return last ? [last] : [];
		}
		const parsed = JSON.parse(raw) as unknown;
		if (!Array.isArray(parsed)) return [];
		const list = parsed.filter(
			(p): p is string =>
				typeof p === "string" && p.length > 0 && !isEphemeralRemoteHandle(p),
		);
		// Self-heal: strip remote handles written by older builds.
		if (list.length !== parsed.length) {
			try {
				localStorage.setItem(RECENT_VAULTS_KEY, JSON.stringify(list));
			} catch {
				// ignore
			}
		}
		return list;
	} catch {
		return [];
	}
}

export function rememberRecentVault(path: string): void {
	const normalized = path.replace(/[\\/]+$/, "");
	if (!normalized || isEphemeralRemoteHandle(normalized)) return;
	try {
		const next = [
			normalized,
			...getRecentVaults().filter(
				(p) => p.replace(/[\\/]+$/, "") !== normalized,
			),
		].slice(0, MAX_RECENT_VAULTS);
		localStorage.setItem(RECENT_VAULTS_KEY, JSON.stringify(next));
	} catch {
		// ignore
	}
}

export function removeRecentVault(path: string): void {
	const normalized = path.replace(/[\\/]+$/, "");
	try {
		const next = getRecentVaults().filter(
			(p) => p.replace(/[\\/]+$/, "") !== normalized,
		);
		localStorage.setItem(RECENT_VAULTS_KEY, JSON.stringify(next));
	} catch {
		// ignore
	}
}

export function saveVaultPath(path: string | null): void {
	try {
		if (path) {
			// Always keep window-session binding (local path or live remote handle).
			sessionStorage.setItem(SESSION_VAULT_KEY, path);
			// Durable "last / recent local" only for real filesystem roots.
			if (!isEphemeralRemoteHandle(path)) {
				localStorage.setItem(LAST_VAULT_KEY, path);
				rememberRecentVault(path);
			}
		} else {
			sessionStorage.removeItem(SESSION_VAULT_KEY);
		}
	} catch {
		// ignore quota / private mode
	}
}
