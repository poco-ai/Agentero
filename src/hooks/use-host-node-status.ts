/**
 * Local-host Node.js / npm readiness for the Agent panes.
 *
 * One `doctor_check_host` probe on mount — never on every render or settings
 * switch. A successful one-click Node install broadcasts
 * `HOST_NODE_INSTALLED_EVENT` (see `lib/doctor/install-node`), so every pane
 * that mounted earlier re-probes and can rescan the Agent catalog; that keeps
 * the bundled-adapter badges and the Agent notice in sync no matter where the
 * install was started (Agent pane or Environment diagnostics).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { errorText } from "@/lib/core/error";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { isTauri } from "@/lib/core/tauri";
import { doctorCheckHost, type HostDoctorReport } from "@/lib/doctor/api";
import {
	HOST_NODE_INSTALLED_EVENT,
	installNodeInBackground,
} from "@/lib/doctor/install-node";
import {
	type HostNodeGap,
	NODE_DOWNLOAD_URL,
} from "@/lib/doctor/node-guidance";

export type HostNodeStatus = {
	nodeMissing: boolean;
	npmMissing: boolean;
	/** Latest host probe; null before the first result or after a failed probe. */
	report: HostDoctorReport | null;
	/** True while a probe is in flight. */
	probing: boolean;
	/** True while the background Node install started here is running. */
	installing: boolean;
	/** Install progress (0–100) while installing, null otherwise. */
	installProgress: number | null;
	/** Re-probe Node.js/npm (manual refresh or after an install elsewhere). */
	refresh: () => Promise<void>;
	/**
	 * Node/npm readiness for a lifecycle guard. Waits for the mount probe (or
	 * starts one if it failed) so a click that lands before the first result
	 * cannot start a Node-dependent install blindly.
	 */
	checkNodeGap: () => Promise<HostNodeGap | null>;
	/** One-click Node.js install + success/failure toast, then re-probe. */
	installNode: () => Promise<void>;
};

export function useHostNodeStatus(
	opts: {
		/** Runs after a successful install, e.g. to rescan the Agent catalog. */
		onInstalled?: () => void | Promise<void>;
	} = {},
): HostNodeStatus {
	const { onInstalled } = opts;
	const { t } = useTranslation("settings");
	const [report, setReport] = useState<HostDoctorReport | null>(null);
	const [probing, setProbing] = useState(() => isTauri());
	const [installing, setInstalling] = useState(false);
	const [installProgress, setInstallProgress] = useState<number | null>(null);
	const reportRef = useRef<HostDoctorReport | null>(null);
	const probeRef = useRef<Promise<HostDoctorReport | null> | null>(null);
	const checkedRef = useRef(false);

	const runProbe = useCallback(async (): Promise<HostDoctorReport | null> => {
		if (!isTauri()) return null;
		setProbing(true);
		try {
			const next = await doctorCheckHost();
			reportRef.current = next;
			setReport(next);
			return next;
		} catch {
			// Environment diagnostics surfaces this failure in its own section;
			// the Agent pane stays quiet instead of adding a second error banner.
			reportRef.current = null;
			setReport(null);
			return null;
		} finally {
			setProbing(false);
		}
	}, []);

	const probe = useCallback(
		async (force: boolean): Promise<HostDoctorReport | null> => {
			if (!force && reportRef.current) return reportRef.current;
			if (probeRef.current) {
				if (!force) return probeRef.current;
				// A forced refresh must observe the post-install state, not the
				// result of a probe that started before the install finished.
				await probeRef.current;
			}
			const request = runProbe();
			probeRef.current = request;
			try {
				return await request;
			} finally {
				if (probeRef.current === request) probeRef.current = null;
			}
		},
		[runProbe],
	);

	const refresh = useCallback(async () => {
		await probe(true);
	}, [probe]);

	const checkNodeGap = useCallback(async (): Promise<HostNodeGap | null> => {
		const current = await probe(false);
		if (!current) return null;
		return {
			nodeMissing: current.node.status !== "available",
			npmMissing: current.npm.status !== "available",
		};
	}, [probe]);

	const handleInstalled = useCallback(async () => {
		await refresh();
		await onInstalled?.();
	}, [onInstalled, refresh]);

	useEffect(() => {
		const onHostNodeInstalled = () => void handleInstalled();
		window.addEventListener(HOST_NODE_INSTALLED_EVENT, onHostNodeInstalled);
		return () =>
			window.removeEventListener(
				HOST_NODE_INSTALLED_EVENT,
				onHostNodeInstalled,
			);
	}, [handleInstalled]);

	useEffect(() => {
		// Probe once per mount; remounts (e.g. a new settings window) re-check.
		if (checkedRef.current) return;
		checkedRef.current = true;
		void checkNodeGap();
	}, [checkNodeGap]);

	const installNode = useCallback(async () => {
		if (!isTauri() || installing) return;
		setInstalling(true);
		setInstallProgress(null);
		try {
			const result = await installNodeInBackground(setInstallProgress);
			// null = not desktop / already running / user cancelled: the task
			// panel row (or the other caller) owns that feedback.
			if (!result) return;
			if (result.outcome === "no-package-manager") {
				notifyError(t("doctor.host.install.noPackageManager"), {
					action: {
						label: t("doctor.host.install.download"),
						onClick: () => openExternalUrl(NODE_DOWNLOAD_URL),
					},
				});
			} else if (result.error) {
				notifyError(result.error);
			} else {
				// The installer's own re-probe is authoritative; show it right away
				// so the caller does not flash the stale "missing" state while the
				// broadcast-triggered refresh runs.
				reportRef.current = result.report;
				setReport(result.report);
				notifySuccess(t("doctor.host.install.success"));
				// The install module broadcast HOST_NODE_INSTALLED_EVENT; the
				// listener above re-probes and rescans for every mounted pane.
			}
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setInstalling(false);
			setInstallProgress(null);
		}
	}, [installing, t]);

	return {
		nodeMissing: report ? report.node.status !== "available" : false,
		npmMissing: report ? report.npm.status !== "available" : false,
		report,
		probing,
		installing,
		installProgress,
		refresh,
		checkNodeGap,
		installNode,
	};
}
