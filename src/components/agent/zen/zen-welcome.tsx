/**
 * Home of a fresh Agent-window conversation: which vault, which harness, and
 * what the two have added up to lately. Both names in the headline are menus,
 * so the next conversation can be aimed at another vault or agent without
 * leaving the page. The heatmap is the Settings → Activity one, fed by the
 * same usage board.
 */

import { ChevronDown } from "lucide-react";
import { memo, type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentLogo } from "@/components/agent/agent-logo";
import { AgentSwitcher } from "@/components/agent/agent-switcher";
import {
	ActivityHeatmap,
	durationText,
	MetricSwitch,
} from "@/components/settings/activity/activity-charts";
import { settingsCardClassName } from "@/components/settings/settings-layout";
import { VaultSwitcherMenu } from "@/components/sidebar/vault-switcher-menu";
import { useVaultStore } from "@/hooks/use-app-stores";
import { useUsageBoard } from "@/hooks/use-usage-board";
import type { UsageDayStat } from "@/lib/activity/api";
import {
	type ActivityMetric,
	boardQueryRange,
	formatTokenCount,
	sumDays,
	tokensReported,
} from "@/lib/activity/board";
import type { AgentTemplate } from "@/lib/agent/api";
import type { AgentOption } from "@/lib/agent/chat-state";
import { cn } from "@/lib/core/utils";
import { vaultDisplayName } from "@/lib/vault";
import {
	createNewVault,
	openRecentVault,
	openRemoteVault,
	openVault,
	removeRecent,
} from "@/lib/vault/actions";

export type ZenWelcomeProps = {
	vaultPath: string | null;
	/** Harness menu rows. */
	options: AgentOption[];
	selectedAgentId: string | null;
	selectedAgentName: string | null;
	/** Template of the selected harness; drives the logo in the headline. */
	selectedAgentTemplate: AgentTemplate | null;
	/** A run or a switch is in flight, so the harness cannot change. */
	agentDisabled: boolean;
	onSelectAgent: (opt: AgentOption) => void;
	onOpenAgentSettings?: () => void;
};

/**
 * A name in the headline that doubles as the trigger of its menu. Returns the
 * `<button>` element itself rather than a component: the menu's trigger needs
 * a DOM element it can attach its props and ref to.
 *
 * With a `logo`, name and logo share one centered grid row, so the logo's
 * vertical middle is the name's whatever the font metrics are. The name comes
 * first in document order: its baseline is the baseline the button (and so the
 * headline) sits on. An icon-first flex row would hand that role to the logo,
 * whose baseline WebKit takes from its inner icon.
 */
function headlineTrigger({
	name,
	label,
	logo = null,
	disabled = false,
}: {
	name: string;
	label: string;
	logo?: ReactNode;
	disabled?: boolean;
}) {
	return (
		<button
			type="button"
			title={label}
			disabled={disabled}
			className={cn(
				"group inline-flex max-w-[min(100%,16rem)] items-center gap-1 rounded-md px-1.5 align-baseline font-semibold text-foreground outline-none",
				"transition-colors duration-150",
				"hover:bg-foreground/[0.06] data-[state=open]:bg-foreground/[0.06]",
				"focus-visible:ring-1 focus-visible:ring-ring active:bg-foreground/10",
				disabled && "cursor-default",
			)}
		>
			{logo ? (
				<span className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2">
					<span className="col-start-2 row-start-1 truncate">{name}</span>
					<span className="col-start-1 row-start-1 flex items-center">
						{logo}
					</span>
				</span>
			) : (
				<span className="truncate">{name}</span>
			)}
			<ChevronDown
				aria-hidden
				className="size-[0.55em] shrink-0 text-muted-foreground/80 transition-transform duration-150 motion-reduce:transition-none group-data-[state=open]:rotate-180"
			/>
		</button>
	);
}

export const ZenWelcome = memo(function ZenWelcome({
	vaultPath,
	options,
	selectedAgentId,
	selectedAgentName,
	selectedAgentTemplate,
	agentDisabled,
	onSelectAgent,
	onOpenAgentSettings,
}: ZenWelcomeProps) {
	const { t } = useTranslation(["agent", "app"]);
	const { t: tSettings } = useTranslation("settings");
	const recentVaults = useVaultStore((s) => s.recentVaults);
	const vaultBusy = useVaultStore((s) => s.busy);
	const { board, today, weekStartsOn, loaded } = useUsageBoard(vaultPath);
	const [metric, setMetric] = useState<ActivityMetric>("reading");

	const { startDay, endDay } = boardQueryRange(today, weekStartsOn);
	const periodSum = (pick: (day: UsageDayStat) => number) =>
		sumDays(board.days, startDay, endDay, pick);
	const periodValue =
		metric === "reading"
			? durationText(
					tSettings,
					periodSum((day) => day.readingMs),
				)
			: tokensReported(board)
				? formatTokenCount(periodSum((day) => day.tokens))
				: tSettings("activity.week.unreported");

	// One sentence per locale; the two names become the menu triggers.
	const [lead, withVault = ""] = t("zen.welcome.headline").split("{{vault}}");
	const [middle, tail = ""] = withVault.split("{{agent}}");
	const vaultName = vaultDisplayName(vaultPath);
	const agentName = selectedAgentName ?? t("defaultName");

	return (
		<div
			data-zen-welcome
			className="mx-auto flex w-full max-w-3xl flex-col items-center gap-6"
		>
			<h2 className="text-balance text-center font-medium text-2xl leading-tight tracking-tight text-foreground/75">
				{lead}
				<VaultSwitcherMenu
					align="center"
					trigger={headlineTrigger({
						name: vaultName,
						label: t("app:vault.switchVault"),
						disabled: vaultBusy,
					})}
					recentVaults={recentVaults}
					vaultPath={vaultPath}
					busy={vaultBusy}
					onOpenRecent={(path) => void openRecentVault(path)}
					onRemoveRecent={removeRecent}
					onOpenVault={() => void openVault()}
					onCreateVault={() => void createNewVault()}
					onOpenRemoteVault={openRemoteVault}
				/>
				{middle}
				<AgentSwitcher
					align="center"
					options={options}
					selected={null}
					selectedAgentId={selectedAgentId}
					disabled={agentDisabled}
					onSelect={onSelectAgent}
					onOpenAgentSettings={onOpenAgentSettings}
					trigger={headlineTrigger({
						name: agentName,
						label: t("switchAgent"),
						// The badge the harness menu shows, so headline and list agree.
						logo: selectedAgentName ? (
							<AgentLogo
								template={selectedAgentTemplate ?? undefined}
								className="size-6"
								iconClassName="size-[1.125rem]"
							/>
						) : null,
						disabled: agentDisabled,
					})}
				/>
				{tail}
			</h2>
			<section
				aria-label={tSettings("activity.title")}
				className={cn(settingsCardClassName, "w-full p-4 sm:p-5")}
			>
				<div className="flex items-center justify-between gap-3">
					<div className="flex min-w-0 items-baseline gap-2">
						<h3 className="shrink-0 text-muted-foreground text-sm">
							{tSettings("activity.heatmap.reading")}
						</h3>
						<p className="min-w-0 truncate font-semibold text-base tabular-nums">
							{loaded ? periodValue : "\u00A0"}
						</p>
					</div>
					<MetricSwitch value={metric} onChange={setMetric} />
				</div>
				<div className="mt-3">
					<ActivityHeatmap
						days={board.days}
						today={today}
						weekStartsOn={weekStartsOn}
						metric={metric}
						fill
					/>
				</div>
			</section>
		</div>
	);
});
