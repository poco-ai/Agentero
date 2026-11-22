import { ExternalLink } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	PROVIDER_INPUT_CLASS,
	ProbeDot,
	ProviderCard,
	ProviderCardHeader,
	ProviderFieldRow,
} from "@/components/settings/provider-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { commands } from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { callApi } from "@/lib/core/ipc";
import { notifyError } from "@/lib/core/notify";
import { openExternalUrl } from "@/lib/core/open-external";
import { hasSecret, isSecretMask, maskSecret } from "@/lib/core/secret-mask";
import { isTauri } from "@/lib/core/tauri";
import type { AppSettings } from "@/lib/settings";
import { applyExternalSettings } from "@/lib/settings/store";
import type { AlphaXivSettings } from "@/lib/settings/types";
import type { ProbeStatus } from "@/lib/ui/probe-status";

const ALPHA_XIV_KEY_PAGE = "https://www.alphaxiv.org/settings/api-keys";

function profileLabel(profile: AlphaXivSettings): string {
	return profile.realName || profile.username || profile.email;
}

/**
 * Paste an AlphaXiv API key, check it with `GET /folders/v3`, and disconnect.
 * A new paste is saved only after the check succeeds. The input shows the
 * Host mask, never the stored key.
 */
export function AlphaXivAuthCard({ alphaxiv }: { alphaxiv: AlphaXivSettings }) {
	const { t } = useTranslation("settings");
	const savedKey = alphaxiv.apiKey;
	const storedLabel = profileLabel(alphaxiv);
	const [draft, setDraft] = useState(savedKey);
	const [pending, setPending] = useState<"test" | "clear" | null>(null);
	const [probe, setProbe] = useState<ProbeStatus>(
		hasSecret(savedKey) ? "ok" : "idle",
	);
	const [probedLabel, setProbedLabel] = useState<string | null>(null);

	useEffect(() => {
		setDraft(savedKey);
		setProbedLabel(null);
		setProbe(hasSecret(savedKey) ? "ok" : "idle");
	}, [savedKey]);

	const label = probedLabel || storedLabel;
	const trimmed = draft.trim();
	const pastedNew = trimmed.length > 0 && !isSecretMask(trimmed);
	const recheck =
		hasSecret(savedKey) && (trimmed === savedKey || isSecretMask(trimmed));
	const canTest = pastedNew || recheck;
	const status: ProbeStatus = pending === "test" ? "probing" : probe;
	const statusLabel = t(
		status === "probing"
			? "general.alphaxiv.statusProbing"
			: status === "ok"
				? "general.alphaxiv.statusOk"
				: status === "fail"
					? "general.alphaxiv.statusFail"
					: "general.alphaxiv.statusIdle",
	);

	const onDraftChange = (next: string) => {
		const shownMask = hasSecret(savedKey)
			? isSecretMask(savedKey)
				? savedKey
				: maskSecret(savedKey)
			: null;
		if (
			shownMask != null &&
			(next === shownMask || next.startsWith(shownMask))
		) {
			setDraft(next.slice(shownMask.length));
			return;
		}
		setDraft(next);
	};

	const test = async () => {
		if (!canTest || pending) return;
		setPending("test");
		try {
			if (pastedNew) {
				const result = await callApi(() => commands.alphaxivSaveKey(trimmed), {
					fallback: t("general.alphaxiv.testFailed"),
				});
				applyExternalSettings(result.settings as AppSettings);
				setProbedLabel(result.account.label);
			} else {
				const account = await callApi(() => commands.alphaxivTestKey(trimmed), {
					fallback: t("general.alphaxiv.testFailed"),
				});
				setProbedLabel(account.label);
			}
			setProbe("ok");
		} catch (error) {
			setProbe("fail");
			notifyError(t("general.alphaxiv.testFailed"), {
				description: errorText(error),
			});
		} finally {
			setPending(null);
		}
	};

	const disconnect = async () => {
		if (pending) return;
		setPending("clear");
		try {
			const next = await callApi(() => commands.alphaxivClearKey(), {
				fallback: t("general.alphaxiv.clearFailed"),
			});
			applyExternalSettings(next as AppSettings);
			setProbedLabel(null);
			setProbe("idle");
		} catch (error) {
			notifyError(t("general.alphaxiv.clearFailed"), {
				description: errorText(error),
			});
		} finally {
			setPending(null);
		}
	};

	return (
		<div className="mb-5">
			<ProviderCard>
				<ProviderCardHeader
					left={
						<>
							<Tooltip>
								<TooltipTrigger asChild>
									<ProbeDot
										status={status}
										configured={hasSecret(savedKey)}
										label={statusLabel}
									/>
								</TooltipTrigger>
								<TooltipContent>{statusLabel}</TooltipContent>
							</Tooltip>
							<p className="min-w-0 truncate font-medium text-sm">
								{t("general.alphaxiv.label")}
							</p>
							<Button
								type="button"
								variant="link"
								size="xs"
								className="-ml-1.5 h-auto shrink-0 px-1.5 text-primary"
								onClick={() => void openExternalUrl(ALPHA_XIV_KEY_PAGE)}
							>
								<ExternalLink data-icon="inline-start" className="size-3" />
								{t("general.alphaxiv.openKeyPage")}
							</Button>
							{label ? (
								<p className="min-w-0 truncate text-muted-foreground text-xs">
									{label}
								</p>
							) : null}
						</>
					}
					right={
						<div className="flex items-center gap-1.5">
							{hasSecret(savedKey) ? (
								<Button
									type="button"
									variant="outline"
									size="xs"
									disabled={!isTauri() || pending !== null}
									onClick={() => void disconnect()}
								>
									{pending === "clear"
										? t("general.alphaxiv.disconnecting")
										: t("general.alphaxiv.disconnect")}
								</Button>
							) : null}
							<Button
								type="button"
								variant="outline"
								size="xs"
								disabled={!isTauri() || !canTest || pending !== null}
								onClick={() => void test()}
							>
								{pending === "test"
									? t("general.alphaxiv.testing")
									: t("general.alphaxiv.test")}
							</Button>
						</div>
					}
				/>
				<div className="grid gap-1.5">
					<ProviderFieldRow
						label={t("general.alphaxiv.keyLabel")}
						htmlFor="alphaxiv-api-key"
					>
						<Input
							id="alphaxiv-api-key"
							type="password"
							autoComplete="off"
							spellCheck={false}
							placeholder={t("general.alphaxiv.placeholder")}
							className={PROVIDER_INPUT_CLASS}
							value={draft}
							disabled={!isTauri() || pending !== null}
							onChange={(event) => onDraftChange(event.currentTarget.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter") void test();
							}}
						/>
					</ProviderFieldRow>
				</div>
			</ProviderCard>
		</div>
	);
}
