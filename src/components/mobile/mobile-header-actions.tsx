import { BookOpen, Check, ChevronDown, FileText, History } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { MobileReaderMode } from "@/components/mobile/types";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { AgentDescriptor } from "@/lib/agent/api";
import { cn } from "@/lib/core/utils";

const MODES: Array<{ id: MobileReaderMode; icon: typeof BookOpen }> = [
	{ id: "pdf", icon: BookOpen },
	{ id: "notes", icon: FileText },
];

export function MobileReaderModeToggle({
	mode,
	onChange,
}: {
	mode: MobileReaderMode;
	onChange: (mode: MobileReaderMode) => void;
}) {
	const { t } = useTranslation("mobile");
	return (
		<div className="flex shrink-0 rounded-lg border bg-muted p-0.5">
			{MODES.map(({ id, icon: Icon }) => (
				<button
					key={id}
					type="button"
					aria-label={t(`reader.${id}`)}
					aria-pressed={mode === id}
					onClick={() => onChange(id)}
					className={cn(
						"grid size-9 place-items-center rounded-md",
						mode === id && "bg-background shadow-raised",
					)}
				>
					<Icon className="size-4" />
				</button>
			))}
		</div>
	);
}

export function MobileAgentToolbar({
	agents,
	loading,
	selectedAgentId,
	onSelectAgent,
	onOpenHistory,
}: {
	agents: AgentDescriptor[];
	loading: boolean;
	selectedAgentId: string | null;
	onSelectAgent: (agentId: string) => void;
	onOpenHistory: () => void;
}) {
	const { t } = useTranslation("mobile");
	const selectedAgent = agents.find((agent) => agent.id === selectedAgentId);
	return (
		<div className="flex min-w-0 items-center gap-1">
			<DropdownMenu>
				<DropdownMenuTrigger asChild disabled={loading || agents.length === 0}>
					<Button
						type="button"
						variant="outline"
						size="sm"
						className="h-9 min-w-0 max-w-[min(48vw,12rem)] justify-between gap-1.5 rounded-lg px-2.5"
						aria-label={t("agent.switchBackend")}
						title={t("agent.switchBackend")}
					>
						<span className="truncate">
							{selectedAgent?.name ?? t("agent.defaultBackend")}
						</span>
						<ChevronDown className="size-4 shrink-0 text-muted-foreground" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="w-56">
					{agents.map((agent) => (
						<DropdownMenuItem
							key={agent.id}
							disabled={!agent.available}
							onSelect={() => {
								if (agent.id !== selectedAgentId) onSelectAgent(agent.id);
							}}
							className="gap-2"
						>
							<span className="min-w-0 flex-1 truncate">{agent.name}</span>
							{agent.id === selectedAgentId ? (
								<Check className="size-4 shrink-0" />
							) : null}
						</DropdownMenuItem>
					))}
				</DropdownMenuContent>
			</DropdownMenu>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				aria-label={t("agent.history")}
				onClick={onOpenHistory}
			>
				<History className="size-4" />
			</Button>
		</div>
	);
}
