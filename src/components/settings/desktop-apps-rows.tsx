import { ArrowUpRight, Loader2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DesktopAppLogo } from "@/components/agent/desktop-app-logo";
import {
	SettingsGroup,
	SettingsSectionLabel,
	settingsRowClassName,
} from "@/components/settings/settings-layout";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import {
	DESKTOP_APP_IDS,
	type DesktopAppId,
	type DesktopAppStatus,
	openDesktopApp,
	probeDesktopApps,
} from "@/lib/system/desktop-apps";

/**
 * Read-only list of popular desktop AI apps that do NOT speak ACP themselves.
 * Each one ships a CLI (ChatGPT → Codex, WorkBuddy → CodeBuddy, QwenWork →
 * Qoder CN, Dsh 桌面版 → Dsh) that Agentero drives over ACP, so the row opens
 * the app and says so; the matching Agent appears in the catalog above.
 * Detection is local-only (see `features/system/desktop_apps`).
 */
export function DesktopAppsSection() {
	const { t } = useTranslation("settings");
	return (
		<>
			<SettingsSectionLabel className="mt-4">
				{t("agent.desktopApps.section")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<DesktopAppsRows />
			</SettingsGroup>
			<p className="mt-2 mb-3 px-0.5 text-muted-foreground text-xs leading-relaxed">
				{t("agent.desktopApps.hint")}
			</p>
		</>
	);
}

function DesktopAppsRows() {
	const { t } = useTranslation("settings");
	const [statuses, setStatuses] = useState<Record<
		string,
		DesktopAppStatus
	> | null>(null);
	const [opening, setOpening] = useState<DesktopAppId | null>(null);

	useEffect(() => {
		if (!isTauri()) {
			setStatuses({});
			return;
		}
		let cancelled = false;
		void (async () => {
			try {
				const list = await probeDesktopApps();
				if (!cancelled) {
					setStatuses(Object.fromEntries(list.map((s) => [s.id, s])));
				}
			} catch (e) {
				if (!cancelled) {
					setStatuses({});
					notifyError(errorText(e));
				}
			}
		})();
		return () => {
			cancelled = true;
		};
	}, []);

	const onOpen = useCallback(async (id: DesktopAppId) => {
		setOpening(id);
		try {
			await openDesktopApp(id);
		} catch (e) {
			notifyError(errorText(e));
		} finally {
			setOpening(null);
		}
	}, []);

	if (statuses === null) {
		return (
			<div className="flex items-center gap-2 px-3.5 py-4 text-muted-foreground text-xs">
				<Loader2 className="size-3.5 animate-spin" aria-hidden />
				{t("agent.desktopApps.scanning")}
			</div>
		);
	}

	return (
		<>
			{DESKTOP_APP_IDS.map((id) => {
				const installed = statuses[id]?.installed ?? false;
				const label = t(`agent.desktopApps.${id}`);
				const icon = (
					<DesktopAppLogo
						id={id}
						className={cn("size-5", !installed && "opacity-40")}
					/>
				);
				const text = (
					<span
						className={cn(
							"truncate text-sm",
							installed ? "text-foreground" : "text-muted-foreground/60",
						)}
					>
						{label}
					</span>
				);

				if (!installed) {
					return (
						<div key={id} className={cn(settingsRowClassName, "gap-3")}>
							<div className="flex min-w-0 items-center gap-2.5">
								{icon}
								{text}
							</div>
						</div>
					);
				}

				return (
					<button
						key={id}
						type="button"
						aria-label={t("agent.desktopApps.open", { name: label })}
						title={t("agent.desktopApps.open", { name: label })}
						disabled={opening !== null}
						onClick={() => void onOpen(id)}
						className={cn(
							settingsRowClassName,
							"w-full gap-3 text-left transition-colors hover:bg-muted/50",
						)}
					>
						<div className="flex min-w-0 items-center gap-2.5">
							{icon}
							{text}
						</div>
						<span className="flex shrink-0 items-center gap-1.5 text-muted-foreground text-xs">
							{t("agent.desktopApps.bundledCli")}
							{opening === id ? (
								<Loader2 className="size-3.5 animate-spin" aria-hidden />
							) : (
								<ArrowUpRight className="size-3.5" aria-hidden />
							)}
						</span>
					</button>
				);
			})}
		</>
	);
}
