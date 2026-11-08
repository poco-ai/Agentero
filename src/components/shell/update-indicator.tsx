import { Download, ExternalLink, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { warnIfNoProxyForDownload } from "@/lib/settings/proxy-guard";
import {
	getUpdateReleaseUrl,
	getUpdateSnapshot,
	installAvailableUpdate,
	subscribeUpdate,
	type UpdateSnapshot,
} from "@/lib/update";

/**
 * Title-bar indicator for a pending app update, rendered as a compact tag.
 * Appears when a verified release is available and stays until the user
 * installs and restarts.
 */
export function UpdateIndicator() {
	const { t } = useTranslation("settings");
	const [update, setUpdate] = useState<UpdateSnapshot>(getUpdateSnapshot);

	useEffect(() => subscribeUpdate(setUpdate), []);

	if (
		update.phase !== "available" &&
		update.phase !== "downloading" &&
		update.phase !== "installing"
	) {
		return null;
	}

	const busy = update.phase !== "available";
	const progress =
		update.totalBytes && update.downloadedBytes !== undefined
			? Math.min(
					100,
					Math.round((update.downloadedBytes / update.totalBytes) * 100),
				)
			: undefined;

	const tooltip = (() => {
		switch (update.phase) {
			case "available":
				return t("about.update.available", {
					version: update.availableVersion,
				});
			case "downloading":
				return progress !== undefined
					? t("about.update.downloadingProgress", { progress })
					: t("about.update.downloading");
			default:
				return t("about.update.installing");
		}
	})();
	const tagText = (() => {
		switch (update.phase) {
			case "available":
				return t("about.update.tagNew");
			case "downloading":
				return progress !== undefined
					? t("about.update.tagDownloading", { progress })
					: t("about.update.tagUpdating");
			default:
				return t("about.update.tagInstalling");
		}
	})();

	const onInstall = () => {
		if (busy) return;
		void warnIfNoProxyForDownload()
			.then(() => installAvailableUpdate())
			.then((next) => {
				if (next.phase === "error") {
					notifyError(t("about.update.installFailed"));
				}
			});
	};

	return (
		<div className="flex items-center gap-1">
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						type="button"
						aria-label={busy ? tooltip : t("about.update.downloadInstall")}
						className={cn(
							"inline-flex h-5 items-center gap-1 rounded-4xl border px-2 text-xs font-medium whitespace-nowrap transition-colors",
							"[&_svg]:pointer-events-none [&_svg]:size-3",
							busy
								? "border-border bg-muted/50 text-muted-foreground"
								: "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 hover:bg-emerald-500/15 dark:text-emerald-400",
						)}
						onClick={onInstall}
					>
						{busy ? <LoaderCircle className="animate-spin" /> : <Download />}
						{tagText}
					</button>
				</TooltipTrigger>
				<TooltipContent side="bottom">{tooltip}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button variant="ghost" size="icon-xs" asChild>
						<a
							href={getUpdateReleaseUrl(update.availableVersion)}
							aria-label={t("about.update.releaseNotes")}
							onClick={(event) => {
								event.preventDefault();
								openExternalUrl(event.currentTarget.href);
							}}
						>
							<ExternalLink aria-hidden />
						</a>
					</Button>
				</TooltipTrigger>
				<TooltipContent side="bottom">
					{t("about.update.releaseNotes")}
				</TooltipContent>
			</Tooltip>
		</div>
	);
}
