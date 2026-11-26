import { Check, ChevronDown, Settings } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentOption } from "@/lib/agent/chat-state";
import { AgentLogo } from "./agent-logo";

export function AgentSwitcher({
	options,
	selected,
	selectedAgentId,
	disabled,
	onSelect,
	onOpenAgentSettings,
	trigger,
	align = "start",
}: {
	options: AgentOption[];
	selected: AgentOption | null | undefined;
	selectedAgentId: string | null;
	disabled: boolean;
	onSelect: (opt: AgentOption) => void;
	onOpenAgentSettings?: () => void;
	/**
	 * Custom trigger (e.g. the Agent workspace headline). It must be a DOM
	 * element, because the menu attaches its trigger props and ref to it. The
	 * default is the rail's compact button.
	 */
	trigger?: ReactNode;
	/** Menu edge that lines up with the trigger's. */
	align?: "start" | "center" | "end";
}) {
	const { t } = useTranslation("agent");

	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild disabled={disabled}>
				{trigger ?? (
					<Button
						type="button"
						variant="ghost"
						size="sm"
						className="h-7 min-w-0 max-w-[9rem] shrink gap-1 px-1.5 font-medium text-sm leading-none"
						aria-label={t("switchAgent")}
						title={t("switchAgent")}
					>
						{selected ? <AgentLogo template={selected.template} /> : null}
						<span className="min-w-0 truncate">
							{selected?.name ?? t("defaultName")}
						</span>
						<ChevronDown className="size-3 shrink-0 opacity-70" />
					</Button>
				)}
			</DropdownMenuTrigger>
			<DropdownMenuContent align={align} className="min-w-[200px]">
				{/* Match DropdownMenuLabel height (px-1.5 py-1 text-xs); keep gear inside the row. */}
				<div className="flex h-6 items-center justify-between gap-1 px-1.5">
					<span className="min-w-0 truncate font-medium text-muted-foreground text-xs leading-none">
						{t("agentMenu.title")}
					</span>
					{onOpenAgentSettings ? (
						<button
							type="button"
							className="inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
							aria-label={t("agentMenu.openSettings")}
							title={t("agentMenu.openSettings")}
							onClick={() => onOpenAgentSettings()}
						>
							<Settings className="size-3" />
						</button>
					) : null}
				</div>
				<DropdownMenuSeparator />
				{options.length === 0 ? (
					<div className="px-2 py-1.5 text-muted-foreground text-xs">
						{t("agentMenu.empty")}
					</div>
				) : (
					options.map((opt) => {
						const isActive =
							selected?.key === opt.key ||
							(opt.id !== null && opt.id === selectedAgentId);
						return (
							<DropdownMenuItem
								key={opt.key}
								className="flex items-center justify-between gap-2"
								onSelect={() => onSelect(opt)}
							>
								<span className="flex min-w-0 items-center gap-2">
									<AgentLogo template={opt.template} />
									<span className="min-w-0 truncate">{opt.name}</span>
								</span>
								{isActive ? (
									<Check className="size-3.5 shrink-0 opacity-80" />
								) : null}
							</DropdownMenuItem>
						);
					})
				)}
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
