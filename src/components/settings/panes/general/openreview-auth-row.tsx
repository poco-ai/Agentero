import { LogIn } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ProbeDot } from "@/components/settings/provider-card";
import { SettingsRow } from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callResult } from "@/lib/core/ipc";
import { notifyError } from "@/lib/core/notify";
import { hasSecret } from "@/lib/core/secret-mask";
import { isTauri } from "@/lib/core/tauri";
import type { ProbeStatus } from "@/lib/ui/probe-status";

/**
 * OpenReview verification for PDF downloads (#1157).
 *
 * The Host opens a dedicated webview on the Turnstile challenge; clearing it
 * (or signing in) captures the clearance cookie, which the download layer then
 * replays. The cookie is IP-bound and short-lived, so the only durable UI state
 * is "verified / expired" plus a button that reopens the window.
 */
export function OpenReviewAuthRow({
	cookie,
	expiresAt,
}: {
	/** Host-masked cookie; only its presence is meaningful here. */
	cookie: string;
	/** Unix seconds, 0 = no readable expiry (browser-session cookie). */
	expiresAt: number;
}) {
	const { t } = useTranslation("settings");
	const [pending, setPending] = useState(false);
	const configured = hasSecret(cookie);
	const expired = configured && expiresAt > 0 && Date.now() / 1000 >= expiresAt;
	const status: ProbeStatus = pending
		? "probing"
		: !configured
			? "idle"
			: expired
				? "fail"
				: "ok";
	const statusLabel = t(
		pending
			? "general.openreviewAuth.statusWaiting"
			: !configured
				? "general.openreviewAuth.statusIdle"
				: expired
					? "general.openreviewAuth.statusExpired"
					: "general.openreviewAuth.statusOk",
	);

	const login = useCallback(async () => {
		setPending(true);
		try {
			await callResult(() => commands.openreviewAuthLoginOpen());
		} catch (error) {
			notifyError(t("general.openreviewAuth.loginFailed"), {
				description: errorText(error),
			});
		} finally {
			setPending(false);
		}
	}, [t]);

	return (
		<SettingsRow
			label={
				<span className="inline-flex items-center gap-1.5">
					{t("general.openreviewAuth.label")}
					<Tooltip>
						<TooltipTrigger asChild>
							<ProbeDot
								status={status}
								configured={configured}
								label={statusLabel}
							/>
						</TooltipTrigger>
						<TooltipContent>{statusLabel}</TooltipContent>
					</Tooltip>
				</span>
			}
		>
			<Button
				type="button"
				variant="outline"
				size="xs"
				disabled={!isTauri() || pending}
				onClick={() => void login()}
			>
				<LogIn data-icon="inline-start" className="size-3" />
				{pending
					? t("general.openreviewAuth.loggingIn")
					: t("general.openreviewAuth.login")}
			</Button>
		</SettingsRow>
	);
}
