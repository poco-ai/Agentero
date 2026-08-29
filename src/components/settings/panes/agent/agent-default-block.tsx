import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentLogo } from "@/components/agent/agent-logo";
import {
	buildDefaultAgentChoices,
	type DefaultAgentChoice,
	defaultAgentChoiceValue,
	NO_DEFAULT_AGENT_CHOICE,
} from "@/components/settings/panes/agent-catalog";
import {
	SettingsGroup,
	SettingsRow,
} from "@/components/settings/settings-layout";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import {
	type CatalogScanResponse,
	ensureCatalogAgent,
	setDefaultAgent,
} from "@/lib/agent";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { isTauri } from "@/lib/core/tauri";

export function AgentDefaultBlock({
	catalog,
	scanOnce,
	onDefaultApplied,
}: {
	catalog: CatalogScanResponse | null;
	scanOnce: () => Promise<CatalogScanResponse | null>;
	/** Refresh dependant registries (e.g. PDF Ask listAgents) after a change. */
	onDefaultApplied: () => void;
}) {
	const { t } = useTranslation("settings");
	const [savingDefaultValue, setSavingDefaultValue] = useState<string | null>(
		null,
	);

	const defaultAgentChoices = useMemo(
		() => buildDefaultAgentChoices(catalog),
		[catalog],
	);
	const selectedDefaultValue = useMemo(
		() => defaultAgentChoiceValue(catalog, defaultAgentChoices),
		[catalog, defaultAgentChoices],
	);

	const onDefaultAgentChange = async (value: string) => {
		if (!isTauri() || value === NO_DEFAULT_AGENT_CHOICE) return;
		const choice = defaultAgentChoices.find((c) => c.value === value);
		if (!choice) return;
		setSavingDefaultValue(value);
		try {
			if (choice.source === "catalog" && choice.templateId) {
				await ensureCatalogAgent(choice.templateId, true);
			} else if (choice.agentId) {
				await setDefaultAgent(choice.agentId);
			}
			await scanOnce();
			onDefaultApplied();
		} catch (e) {
			notifyError(errorText(e));
		} finally {
			setSavingDefaultValue(null);
		}
	};

	return (
		<>
			<p className="mb-1.5 font-medium text-muted-foreground text-xs uppercase tracking-wide">
				{t("agent.defaultAgent.section")}
			</p>
			<SettingsGroup>
				<SettingsRow
					label={t("agent.defaultAgent.label")}
					description={t("agent.defaultAgent.description")}
				>
					<Select
						value={selectedDefaultValue}
						onValueChange={(v) => void onDefaultAgentChange(v)}
						disabled={
							!isTauri() ||
							defaultAgentChoices.length === 0 ||
							Boolean(savingDefaultValue)
						}
					>
						<SelectTrigger size="sm" className="min-w-[220px] max-w-[300px]">
							<SelectValue placeholder={t("agent.defaultAgent.empty")} />
						</SelectTrigger>
						<SelectContent>
							{selectedDefaultValue === NO_DEFAULT_AGENT_CHOICE ? (
								<SelectItem value={NO_DEFAULT_AGENT_CHOICE} disabled>
									{defaultAgentChoices.length === 0
										? t("agent.defaultAgent.empty")
										: t("agent.defaultAgent.placeholder")}
								</SelectItem>
							) : null}
							{defaultAgentChoices.map((choice) => (
								<SelectItem key={choice.value} value={choice.value}>
									<AgentChoiceLabel choice={choice} />
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</SettingsRow>
			</SettingsGroup>
		</>
	);
}

function AgentChoiceLabel({ choice }: { choice: DefaultAgentChoice }) {
	return (
		<span className="flex min-w-0 items-center gap-2">
			<AgentLogo template={choice.template} />
			<span className="min-w-0 truncate">{choice.name}</span>
		</span>
	);
}
