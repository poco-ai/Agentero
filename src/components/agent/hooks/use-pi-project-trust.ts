import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentTemplate } from "@/lib/agent";
import {
	grantPiProjectTrust,
	piProjectTrustStatus,
	warmAgent,
} from "@/lib/agent";
import { errorText } from "@/lib/agent/chat-state";
import { notifyError } from "@/lib/core/notify";
import { isRemoteVaultHandle } from "@/lib/vault/remote/remote-vault";

/**
 * Trust can be granted outside Agentero (Pi's own TUI prompt or a settings
 * edit). While the notice is visible, re-probe so it disappears without a
 * remount; the Host starts a fresh Pi process on the next turn either way.
 */
const TRUST_RECHECK_MS = 5_000;

type Status = {
	key: string;
	required: boolean;
	trusted: boolean;
};

/**
 * Pi project-trust state for the selected agent + Vault.
 *
 * Only local Pi Vaults are queried: remote agents run on the remote host and
 * cannot be trusted from this machine. A failed probe hides the notice instead
 * of blocking chat; granting trust reports the Host error.
 */
export function usePiProjectTrust({
	vaultPath,
	agentId,
	template,
}: {
	vaultPath: string | null;
	agentId: string | null | undefined;
	template: AgentTemplate | null | undefined;
}) {
	const key =
		template === "pi" && agentId && vaultPath && !isRemoteVaultHandle(vaultPath)
			? `${agentId}\0${vaultPath}`
			: null;
	const [status, setStatus] = useState<Status | null>(null);
	const [dismissedKey, setDismissedKey] = useState<string | null>(null);
	const [trusting, setTrusting] = useState(false);
	const keyRef = useRef(key);
	keyRef.current = key;

	const probe = useCallback(async () => {
		if (!key || !agentId || !vaultPath) return;
		const probeKey = key;
		try {
			const next = await piProjectTrustStatus(agentId, vaultPath);
			if (keyRef.current === probeKey) {
				setStatus((prev) =>
					prev?.key === probeKey &&
					prev.required === next.required &&
					prev.trusted === next.trusted
						? prev
						: { key: probeKey, required: next.required, trusted: next.trusted },
				);
			}
		} catch {
			// The vault may have been replaced or Pi's settings are unreadable;
			// no actionable notice can be shown in that case.
			if (keyRef.current === probeKey) setStatus(null);
		}
	}, [agentId, key, vaultPath]);

	useEffect(() => {
		if (!key) {
			setStatus(null);
			return;
		}
		void probe();
	}, [key, probe]);

	// Pi resolves trust only when its process starts, so a decision made
	// elsewhere is invisible to this panel until the next probe.
	useEffect(() => {
		if (!key) return;
		const onFocus = () => void probe();
		const onVisibility = () => {
			if (document.visibilityState === "visible") void probe();
		};
		window.addEventListener("focus", onFocus);
		document.addEventListener("visibilitychange", onVisibility);
		return () => {
			window.removeEventListener("focus", onFocus);
			document.removeEventListener("visibilitychange", onVisibility);
		};
	}, [key, probe]);

	const visible =
		!!key &&
		status?.key === key &&
		status.required &&
		!status.trusted &&
		dismissedKey !== key;

	useEffect(() => {
		if (!visible) return;
		const timer = window.setInterval(() => void probe(), TRUST_RECHECK_MS);
		return () => window.clearInterval(timer);
	}, [probe, visible]);

	const dismiss = useCallback(() => {
		if (key) setDismissedKey(key);
	}, [key]);

	const trust = useCallback(async () => {
		if (!key || !agentId || !vaultPath || trusting) return;
		setTrusting(true);
		try {
			const next = await grantPiProjectTrust(agentId, vaultPath);
			setStatus({ key, required: next.required, trusted: next.trusted });
			// Warm a trusted process right away: the composer picks up the newly
			// visible skill commands, and the next turn inherits the fresh session.
			void warmAgent({ agentId, vaultPath }).catch(() => undefined);
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setTrusting(false);
		}
	}, [agentId, key, trusting, vaultPath]);

	return { visible, trusting, dismiss, trust };
}
