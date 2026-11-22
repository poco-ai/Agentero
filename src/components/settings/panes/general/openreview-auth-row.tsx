import { LogIn } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
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
	const [accountExpiry, setAccountExpiry] = useState<number | null>(null);
	useEffect(() => {
		if (!isTauri()) return;
		let active = true;
		const refresh = () => {
			void commands
				.openreviewAccountExpiry()
				.then((expiry) => {
					if (active) setAccountExpiry(expiry);
				})
				.catch(() => undefined);
		};
		refresh();
		window.addEventListener("focus", refresh);
		return () => {
			active = false;
			window.removeEventListener("focus", refresh);
		};
	}, []);
	const now = Date.now() / 1000;
	const hasAccount = accountExpiry !== null;
	const signedIn = hasAccount && accountExpiry > now;
	const hasVerification = hasSecret(cookie);
	const verified = hasVerification && (expiresAt <= 0 || expiresAt > now);
	const configured = hasAccount || hasVerification;
	const status: ProbeStatus = pending
		? "probing"
		: signedIn || verified
			? "ok"
			: configured
				? "fail"
				: "idle";
	const statusLabel = t(
		pending
			? "general.openreviewAuth.statusWaiting"
			: signedIn
				? "general.openreviewAuth.statusSignedIn"
				: verified
					? "general.openreviewAuth.statusOk"
					: hasAccount
						? "general.openreviewAuth.statusSessionExpired"
						: hasVerification
							? "general.openreviewAuth.statusExpired"
							: "general.openreviewAuth.statusIdle",
	);

	const login = useCallback(async () => {
		setPending(true);
		try {
			await callResult(() => commands.openreviewAuthLoginOpen());
			setAccountExpiry(await commands.openreviewAccountExpiry());
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
			className="px-3"
			label={
				<span className="inline-flex items-center gap-1.5">
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
					{t("general.openreviewAuth.label")}
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
