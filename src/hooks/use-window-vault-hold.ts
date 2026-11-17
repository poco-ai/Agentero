/**
 * Per-window vault hold for popouts that do not run `useAppBootstrap`.
 *
 * The main window holds inside `vault:opened` and releases once from that
 * scope's teardown. `activateVault` must not hold again: Host hold is
 * idempotent per window, so the extra registration is free, but the main
 * window's single release would drop it while the vault was still open.
 * This hook records only the path it successfully held, and releases that
 * path on unmount.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApi } from "@/lib/core/ipc";
import { logger } from "@/lib/core/logger";
import { isTauri } from "@/lib/core/tauri";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";

function canonicalVaultPath(path: string | null | undefined): string {
	return (path ?? "").trim().replace(/[\\/]+$/, "");
}

/** Trailing-separator-insensitive identity, matching `openLocalVaultPath`. */
export function vaultPathsMatch(
	a: string | null | undefined,
	b: string | null | undefined,
): boolean {
	const left = canonicalVaultPath(a);
	const right = canonicalVaultPath(b);
	return left.length > 0 && left === right;
}

async function holdVaultForWindow(path: string): Promise<boolean> {
	if (!isTauri() || isRemoteVaultHandle(path)) return false;
	try {
		await callApi(() => commands.vaultHold(path), {
			fallback: "vault hold failed",
		});
		return true;
	} catch (e: unknown) {
		logger.warn("vault hold failed", { error: errorText(e) });
		return false;
	}
}

function releaseVaultForWindow(path: string): void {
	if (!isTauri() || isRemoteVaultHandle(path)) return;
	void callApi(() => commands.vaultRelease(path), {
		fallback: "vault release failed",
	}).catch(() => undefined);
}

export type WindowVaultHold = {
	/** Start a vault operation. Invalidates any older ticket. */
	claim(): number;
	current(): number;
	/** Drop `ticket` only while it is still the current one. */
	invalidate(ticket: number): void;
	/**
	 * Run `task` after older vault operations. A stale ticket is skipped.
	 * Call `adopt` from inside `task`; it does not re-enter this queue.
	 */
	enqueue(ticket: number, task: () => Promise<void>): Promise<void>;
	/**
	 * Release the vault this window holds, then hold `path`. Empty and remote
	 * paths release the previous local vault and do not hold.
	 */
	adopt(path: string, ticket: number): Promise<void>;
};

export function useWindowVaultHold(): WindowVaultHold {
	const heldRef = useRef<string | null>(null);
	const epochRef = useRef(0);
	const queueRef = useRef(Promise.resolve());
	const runningRef = useRef(0);

	useEffect(() => {
		return () => {
			epochRef.current += 1;
			const path = heldRef.current;
			heldRef.current = null;
			if (path) releaseVaultForWindow(path);
		};
	}, []);

	const claim = useCallback(() => {
		epochRef.current += 1;
		return epochRef.current;
	}, []);

	const current = useCallback(() => epochRef.current, []);

	const invalidate = useCallback((ticket: number) => {
		if (epochRef.current === ticket) epochRef.current += 1;
	}, []);

	const adoptBody = useCallback(async (path: string, ticket: number) => {
		if (ticket !== epochRef.current) return;
		const key = canonicalVaultPath(path);
		if (key && vaultPathsMatch(heldRef.current, key)) return;
		const previous = heldRef.current;
		if (previous) {
			heldRef.current = null;
			releaseVaultForWindow(previous);
		}
		if (ticket !== epochRef.current) return;
		if (!key || isRemoteVaultHandle(key)) return;
		const held = await holdVaultForWindow(key);
		if (ticket !== epochRef.current) {
			if (held) releaseVaultForWindow(key);
			return;
		}
		if (held) heldRef.current = key;
	}, []);

	const enqueue = useCallback((ticket: number, task: () => Promise<void>) => {
		const run = queueRef.current.then(async () => {
			if (ticket !== epochRef.current) return;
			runningRef.current += 1;
			try {
				await task();
			} finally {
				runningRef.current -= 1;
			}
		});
		queueRef.current = run.then(
			() => undefined,
			() => undefined,
		);
		return run;
	}, []);

	const adopt = useCallback(
		(path: string, ticket: number) => {
			if (runningRef.current > 0) return adoptBody(path, ticket);
			return enqueue(ticket, () => adoptBody(path, ticket));
		},
		[adoptBody, enqueue],
	);

	return useMemo(
		() => ({ claim, current, invalidate, enqueue, adopt }),
		[claim, current, invalidate, enqueue, adopt],
	);
}
