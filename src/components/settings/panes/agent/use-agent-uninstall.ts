import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type AgentTemplate,
	type CatalogEntry,
	type CatalogScanResponse,
	removeAgent,
	type ToolLifecycleAction,
	toolUninstallInfo,
	type UninstallInfo,
} from "@/lib/agent";
import { errorText } from "@/lib/core/error";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";

export type UninstallTarget =
	| { kind: "catalog"; entry: CatalogEntry; info: UninstallInfo | null }
	| { kind: "custom"; id: string; name: string; template: AgentTemplate };

/** Uninstall/remove confirmation flow for catalog and custom agents. */
export function useAgentUninstall({
	scanOnce,
	onToolLifecycle,
}: {
	/** Rescan after registry removal so rows / badges update. */
	scanOnce: () => Promise<CatalogScanResponse | null>;
	/** Full uninstall (binaries + registry) runs the install/update lifecycle. */
	onToolLifecycle: (
		entry: CatalogEntry,
		action: ToolLifecycleAction,
	) => Promise<boolean>;
}) {
	const { t } = useTranslation("settings");
	/** Target of the uninstall/remove confirmation dialog. */
	const [uninstallTarget, setUninstallTarget] =
		useState<UninstallTarget | null>(null);
	const [uninstallBusy, setUninstallBusy] = useState(false);

	const openUninstallDialog = useCallback((target: UninstallTarget) => {
		if (!isTauri()) return;
		if (target.kind === "catalog") {
			setUninstallTarget({ ...target, info: null });
			void toolUninstallInfo(target.entry.templateId)
				.then((info) => {
					setUninstallTarget((prev) =>
						prev?.kind === "catalog" &&
						prev.entry.templateId === target.entry.templateId
							? { ...prev, info }
							: prev,
					);
				})
				.catch((e) => {
					notifyError(errorText(e));
					setUninstallTarget(null);
				});
			return;
		}
		setUninstallTarget(target);
	}, []);

	const onUninstallConfirm = async () => {
		const target = uninstallTarget;
		if (!target || !isTauri()) return;
		if (target.kind === "catalog") {
			const info = target.info;
			const hasPayload =
				info !== null && (info.npmCommands.length > 0 || info.dirs.length > 0);
			if (hasPayload) {
				// Full uninstall runs the lifecycle (binaries + registry entry).
				const entry = target.entry;
				setUninstallTarget(null);
				await onToolLifecycle(entry, "uninstall");
				return;
			}
			// Registry-only removal (e.g. hermes has no managed uninstall).
			setUninstallBusy(true);
			try {
				if (target.entry.registeredId) {
					await removeAgent(target.entry.registeredId);
				}
				await scanOnce();
				notifySuccess(t("agent.removeSuccess", { name: target.entry.name }));
			} catch (e) {
				notifyError(errorText(e));
			} finally {
				setUninstallBusy(false);
				setUninstallTarget(null);
			}
			return;
		}
		setUninstallBusy(true);
		try {
			await removeAgent(target.id);
			await scanOnce();
			notifySuccess(t("agent.removeSuccess", { name: target.name }));
		} catch (e) {
			notifyError(errorText(e));
		} finally {
			setUninstallBusy(false);
			setUninstallTarget(null);
		}
	};

	return {
		uninstallTarget,
		setUninstallTarget,
		uninstallBusy,
		openUninstallDialog,
		onUninstallConfirm,
	};
}
