import { Download, LoaderCircle, MousePointerClick } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsRow } from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import { lifecycleErrorMessage } from "@/lib/agent/lifecycle-error";
import {
	type FinderServiceStatus,
	fetchFinderServiceStatus,
	installFinderService,
	uninstallFinderService,
} from "@/lib/cli/api";
import { errorText } from "@/lib/core/error";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { isMacOS, isTauri } from "@/lib/core/tauri";

/**
 * Finder "Open with Agentero" Quick Action (macOS only).
 *
 * Renders nothing on other platforms or when the Host does not support it, so
 * callers can mount it unconditionally inside a settings group.
 */
export function FinderIntegrationRow() {
	const { t } = useTranslation("settings");
	const [status, setStatus] = useState<FinderServiceStatus | null>(null);
	const [busy, setBusy] = useState(false);
	const isMac = useMemo(() => isMacOS(), []);

	const refresh = useCallback(async () => {
		if (!isTauri() || !isMac) return;
		try {
			setStatus(await fetchFinderServiceStatus());
		} catch {
			setStatus(null);
		}
	}, [isMac]);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	if (!isTauri() || !isMac || status?.supported === false) return null;

	const needsUpdate = Boolean(status?.installed && !status.current);
	const description = (() => {
		if (!status) return "…";
		if (status.installed && !status.current) return t("general.finder.stale");
		if (status.installed) return t("general.finder.descriptionInstalled");
		return t("general.finder.description");
	})();

	const onInstall = () => {
		setBusy(true);
		void installFinderService()
			.then(async (next) => {
				setStatus(next);
				await refresh();
				notifySuccess(t("general.finder.installSuccess"));
			})
			.catch((err) =>
				notifyError(t("general.finder.installFailed"), {
					description: lifecycleErrorMessage(errorText(err), (key, options) =>
						t(key, { ...options, defaultValue: "" }),
					),
				}),
			)
			.finally(() => setBusy(false));
	};
	const onUninstall = () => {
		setBusy(true);
		void uninstallFinderService()
			.then(async (next) => {
				setStatus(next);
				await refresh();
				notifySuccess(t("general.finder.uninstallSuccess"));
			})
			.catch((err) =>
				notifyError(t("general.finder.uninstallFailed"), {
					description: errorText(err),
				}),
			)
			.finally(() => setBusy(false));
	};

	return (
		<SettingsRow
			label={
				<span className="inline-flex items-center gap-1.5">
					<MousePointerClick
						className="size-3.5 shrink-0 text-muted-foreground"
						aria-hidden
					/>
					{t("general.finder.label")}
				</span>
			}
			description={description}
		>
			<div className="flex flex-wrap items-center justify-end gap-2">
				{status?.installed ? (
					<Button
						variant="outline"
						size="sm"
						disabled={busy}
						onClick={onUninstall}
					>
						{busy ? (
							<LoaderCircle data-icon="inline-start" className="animate-spin" />
						) : null}
						{t("general.finder.uninstall")}
					</Button>
				) : null}
				{!status?.installed || needsUpdate ? (
					<Button size="sm" disabled={busy || !status} onClick={onInstall}>
						{busy ? (
							<LoaderCircle data-icon="inline-start" className="animate-spin" />
						) : (
							<Download data-icon="inline-start" />
						)}
						{needsUpdate
							? t("general.finder.update")
							: t("general.finder.install")}
					</Button>
				) : null}
			</div>
		</SettingsRow>
	);
}
