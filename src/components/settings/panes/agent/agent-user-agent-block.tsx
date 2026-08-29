import { ChevronDown } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { setAgentUserAgent, USER_AGENT_PRESETS } from "@/lib/agent";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";

export function AgentUserAgentBlock({
	initialUserAgent,
	initialProviderIds,
	onCommitted,
}: {
	initialUserAgent: string;
	initialProviderIds: string;
	/** Mirror the committed values into the parent catalog scan state. */
	onCommitted: (next: {
		userAgent: string;
		userAgentProviderIds: string;
	}) => void;
}) {
	const { t } = useTranslation("settings");
	/** Draft for optional ACP User-Agent (Codex / mid-station affinity). */
	const [userAgentDraft, setUserAgentDraft] = useState(initialUserAgent);
	const [userAgentProviderDraft, setUserAgentProviderDraft] =
		useState(initialProviderIds);
	// The first catalog scan happens after mount (auto-probe): adopt the
	// Host-reported values once they arrive, and again when commits / rescans
	// report fresh state (unchanged values keep the user's uncommitted edit).
	useEffect(() => {
		setUserAgentDraft(initialUserAgent);
		setUserAgentProviderDraft(initialProviderIds);
	}, [initialUserAgent, initialProviderIds]);

	const commitUserAgent = useCallback(
		async (override?: { userAgent?: string; providerIds?: string }) => {
			if (!isTauri()) return;
			const ua = (override?.userAgent ?? userAgentDraft).trim();
			const providers = (
				override?.providerIds ?? userAgentProviderDraft
			).trim();
			try {
				const next = await setAgentUserAgent(ua, providers);
				setUserAgentDraft(next.userAgent);
				setUserAgentProviderDraft(next.userAgentProviderIds);
				onCommitted(next);
			} catch (e) {
				notifyError(errorText(e));
			}
		},
		[userAgentDraft, userAgentProviderDraft, onCommitted],
	);

	return (
		<>
			{/* Advanced / rare: mid-station User-Agent injection (#207). */}
			<p className="mb-1.5 mt-4 font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{t("agent.userAgent.section")}
			</p>
			<SettingsGroup>
				<SettingsRow
					label={t("agent.userAgent.label")}
					htmlFor="agent-user-agent"
				>
					<div className="flex min-w-0 flex-col items-end gap-1.5">
						<div className="relative">
							<Input
								id="agent-user-agent"
								value={userAgentDraft}
								onChange={(e) => setUserAgentDraft(e.target.value)}
								onBlur={() => void commitUserAgent()}
								onKeyDown={(e) => {
									if (e.key === "Enter") {
										e.currentTarget.blur();
									}
								}}
								placeholder={t("agent.userAgent.placeholder")}
								spellCheck={false}
								autoComplete="off"
								disabled={!isTauri()}
								className="h-8 w-44 pr-7 text-xs sm:w-52"
							/>
							<DropdownMenu>
								<DropdownMenuTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon-xs"
										className="absolute top-1/2 right-1 size-6 -translate-y-1/2"
										aria-label={t("agent.userAgent.presetsAria")}
										title={t("agent.userAgent.presetsAria")}
										disabled={!isTauri()}
									>
										<ChevronDown className="size-3.5" aria-hidden />
									</Button>
								</DropdownMenuTrigger>
								<DropdownMenuContent align="end">
									{USER_AGENT_PRESETS.map((preset) => (
										<DropdownMenuItem
											key={preset.id}
											onSelect={() =>
												void commitUserAgent({ userAgent: preset.value })
											}
										>
											{preset.value || t("agent.userAgent.off")}
										</DropdownMenuItem>
									))}
								</DropdownMenuContent>
							</DropdownMenu>
						</div>
					</div>
				</SettingsRow>
				<SettingsRow
					label={t("agent.userAgent.providerIdsLabel")}
					htmlFor="agent-user-agent-providers"
				>
					<Input
						id="agent-user-agent-providers"
						value={userAgentProviderDraft}
						onChange={(e) => setUserAgentProviderDraft(e.target.value)}
						onBlur={() => void commitUserAgent()}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.currentTarget.blur();
							}
						}}
						placeholder={t("agent.userAgent.providerIdsPlaceholder")}
						spellCheck={false}
						autoComplete="off"
						disabled={!isTauri() || !userAgentDraft.trim()}
						className="h-8 w-56 text-xs"
					/>
				</SettingsRow>
			</SettingsGroup>
		</>
	);
}
