import { useTranslation } from "react-i18next";
import { SettingsGroup } from "@/components/settings/settings-layout";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AppSettings } from "@/lib/settings";

export function AgentPersonalPromptBlock({
	settings,
	patch,
}: {
	settings: AppSettings;
	patch: (p: Partial<AppSettings>) => void;
}) {
	const { t } = useTranslation("settings");
	return (
		<SettingsGroup>
			<div className="flex flex-col gap-1.5 px-3.5 py-2.5">
				<Label
					htmlFor="agent-personal-prompt"
					className="font-normal text-[13px]"
				>
					{t("agent.personalPrompt.label")}
				</Label>
				<Textarea
					id="agent-personal-prompt"
					value={settings.agentPersonalPrompt}
					onChange={(e) =>
						patch({
							agentPersonalPrompt: e.target.value.slice(0, 8000),
						})
					}
					onBlur={() => {
						const trimmed = settings.agentPersonalPrompt.trim();
						if (trimmed !== settings.agentPersonalPrompt) {
							patch({ agentPersonalPrompt: trimmed });
						}
					}}
					placeholder={t("agent.personalPrompt.placeholder")}
					rows={4}
					className="min-h-[88px] resize-y text-xs placeholder:text-muted-foreground/50"
					spellCheck={true}
				/>
			</div>
		</SettingsGroup>
	);
}
