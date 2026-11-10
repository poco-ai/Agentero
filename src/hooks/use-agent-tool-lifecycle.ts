import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useHostNodeStatus } from "@/hooks/use-host-node-status";
import i18n from "@/i18n";
import {
	type CatalogEntry,
	type CatalogScanResponse,
	runToolLifecycle as runAgentToolLifecycle,
	type ToolLifecycleAction,
} from "@/lib/agent";
import {
	isNpmMissingError,
	lifecycleErrorMessage,
} from "@/lib/agent/lifecycle-error";
import { BACKGROUND_TASK_CANCELLED_MESSAGE } from "@/lib/core/background-tasks";
import { commands, events } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { listenEventSafe } from "@/lib/core/tauri-events";
import {
	isLifecycleNodeBlocked,
	lifecycleNeedsNode,
} from "@/lib/doctor/node-guidance";
import { ensureVault } from "@/lib/vault";
import { getVaultPath } from "@/lib/vault/store";

export type LifecycleProgressState = {
	progress: number | null;
	detail: string;
};

export function useAgentToolLifecycle(opts: {
	scanOnce: () => Promise<CatalogScanResponse | null>;
	probeInstalled?: (scan: CatalogScanResponse, force: boolean) => Promise<void>;
	/** Re-compare CLI versions so Upgrade hides after a successful update. */
	refreshVersions?: () => Promise<CatalogScanResponse | null>;
	onError?: (message: string) => void;
}) {
	const { t } = useTranslation("settings");
	const { scanOnce, probeInstalled, refreshVersions, onError } = opts;
	const [lifecycleBusyIds, setLifecycleBusyIds] = useState<
		Map<string, ToolLifecycleAction>
	>(() => new Map());
	const [lifecycleProgress, setLifecycleProgress] = useState<
		Record<string, LifecycleProgressState>
	>({});
	/** In-flight lifecycle taskId per template, so a cancel button can signal Host. */
	const taskIdsRef = useRef<Map<string, string>>(new Map());

	const patchLifecycleProgress = useCallback(
		(templateId: string, patch: Partial<LifecycleProgressState>) => {
			setLifecycleProgress((prev) => {
				const current = prev[templateId] ?? {
					progress: null,
					detail: t("agent.lifecycleInstalling"),
				};
				return {
					...prev,
					[templateId]: { ...current, ...patch },
				};
			});
		},
		[t],
	);

	const clearLifecycleProgress = useCallback((templateId: string) => {
		setLifecycleProgress((prev) => {
			if (!(templateId in prev)) return prev;
			const next = { ...prev };
			delete next[templateId];
			return next;
		});
	}, []);

	const lifecyclePhaseLabel = useCallback(
		(phase: string) => {
			if (phase === "agent-lifecycle-waiting") {
				return t("agent.lifecycleWaiting");
			}
			if (phase === "agent-lifecycle-uninstall") {
				return t("agent.lifecycleUninstalling");
			}
			return t("agent.lifecycleInstalling");
		},
		[t],
	);

	/** After a successful Node install, refresh catalog badges (bundled adapter / npm CLIs). */
	const rescanAfterNodeInstall = useCallback(async () => {
		const scan = await scanOnce();
		if (scan && probeInstalled) await probeInstalled(scan, false);
		if (refreshVersions) await refreshVersions();
	}, [scanOnce, probeInstalled, refreshVersions]);

	/**
	 * Local Node.js/npm readiness: drives the Agent pane notice, and lets the
	 * npm/bundled-adapter lifecycle actions guide the user to install Node
	 * instead of starting a doomed background install (Fix #786).
	 */
	const hostNode = useHostNodeStatus({ onInstalled: rescanAfterNodeInstall });
	const { checkNodeGap, installNode } = hostNode;

	const runToolLifecycle = useCallback(
		async (
			entry: CatalogEntry,
			action: ToolLifecycleAction,
		): Promise<boolean> => {
			if (!isTauri()) return false;
			// npm / bundled-JS adapter actions cannot run without Node.js/npm:
			// guide the user to install it instead of failing silently in the
			// background task. Wait for the mount probe so a click that lands
			// before its first result cannot bypass this guard.
			const needsNode = lifecycleNeedsNode(entry, action);
			const nodeGap = needsNode ? await checkNodeGap() : null;
			if (needsNode && isLifecycleNodeBlocked(entry, action, nodeGap)) {
				const canInstall =
					nodeGap?.nodeMissing === true || nodeGap?.npmMissing === true;
				const message = canInstall
					? t("agent.nodeRequired")
					: t("agent.nodeUnusable");
				onError?.(message);
				notifyError(message, {
					action: canInstall
						? {
								label: t("doctor.host.install.button"),
								onClick: installNode,
							}
						: undefined,
				});
				return false;
			}
			setLifecycleBusyIds((prev) => {
				const next = new Map(prev);
				next.set(entry.templateId, action);
				return next;
			});
			const taskId = `agent-lifecycle-${entry.templateId}-${Date.now().toString(36)}`;
			taskIdsRef.current.set(entry.templateId, taskId);
			const stopProgress = listenEventSafe(
				events.agentLifecycleProgress,
				(payload) => {
					if (payload.taskId !== taskId) return;
					patchLifecycleProgress(entry.templateId, {
						progress: payload.progress,
						detail: lifecyclePhaseLabel(payload.phase),
					});
				},
			);
			try {
				patchLifecycleProgress(entry.templateId, {
					progress: 5,
					detail: t(
						action === "uninstall"
							? "agent.lifecycleUninstalling"
							: "agent.lifecycleInstalling",
					),
				});
				await runAgentToolLifecycle(entry.templateId, action, taskId);
				patchLifecycleProgress(entry.templateId, {
					progress: 70,
					detail: t("agent.lifecycleScanning"),
				});
				const scan = await scanOnce();
				if (scan && probeInstalled) {
					patchLifecycleProgress(entry.templateId, {
						progress: 85,
						detail: t("agent.lifecycleProbing"),
					});
					await probeInstalled(scan, true);
				}
				if (refreshVersions) {
					await refreshVersions();
				}
				notifySuccess(
					t(
						action === "update"
							? "agent.updateSuccess"
							: action === "uninstall"
								? "agent.uninstallSuccess"
								: "agent.installSuccess",
						{ name: entry.name },
					),
				);
				// A freshly installed CLI can be a new skill consumer (Claude Code
				// reads `.claude/skills`); re-ensure now instead of on the next
				// vault open. Fire-and-forget: install success never waits on it.
				if (action !== "uninstall") {
					const path = getVaultPath();
					if (path) void ensureVault(path, i18n.language).catch(() => {});
				}
				return true;
			} catch (e) {
				const message = lifecycleErrorMessage(errorText(e), (key, options) =>
					t(key, { ...options, defaultValue: "" }),
				);
				// User-initiated cancel is not an error: no toast, no red banner.
				if (message !== BACKGROUND_TASK_CANCELLED_MESSAGE) {
					onError?.(message);
					if (isNpmMissingError(message)) {
						// npm missing on PATH: offer a one-click Node.js install
						// (npm ships with Node) as a background task.
						notifyError(message, {
							action: {
								label: t("doctor.host.install.button"),
								onClick: installNode,
							},
						});
					} else {
						notifyError(message);
					}
				}
				return false;
			} finally {
				stopProgress();
				taskIdsRef.current.delete(entry.templateId);
				clearLifecycleProgress(entry.templateId);
				setLifecycleBusyIds((prev) => {
					const next = new Map(prev);
					next.delete(entry.templateId);
					return next;
				});
			}
		},
		[
			checkNodeGap,
			clearLifecycleProgress,
			installNode,
			lifecyclePhaseLabel,
			onError,
			patchLifecycleProgress,
			probeInstalled,
			refreshVersions,
			scanOnce,
			t,
		],
	);

	const cancelToolLifecycle = useCallback((templateId: string) => {
		if (!isTauri()) return;
		const taskId = taskIdsRef.current.get(templateId);
		if (!taskId) return;
		// Host polls the lifecycle cancel registry and kills the install child
		// process. Not cancelBackgroundTask: this task is never registered in
		// that store.
		void commands.agentLifecycleCancel(taskId).catch(() => {});
	}, []);

	return {
		lifecycleBusyIds,
		lifecycleProgress,
		runToolLifecycle,
		cancelToolLifecycle,
		/** Local Node.js/npm readiness — the Agent pane renders the install notice from it. */
		hostNode,
	};
}
