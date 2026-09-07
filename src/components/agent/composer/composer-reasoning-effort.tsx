import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import type { AgentEffortChoice } from "@/lib/agent";

/** Compact effort control beside the current model; labels come from ACP. */
export function ComposerReasoningEffort({
	options,
	value,
	disabled,
	onChange,
}: {
	options: AgentEffortChoice[];
	value: string | null;
	disabled: boolean;
	onChange: (id: string) => void;
}) {
	const { t } = useTranslation("agent");
	const selected = options.find((option) => option.id === value);
	if (!value) return null;
	return (
		<DropdownMenu>
			<Tooltip>
				<TooltipTrigger asChild>
					<DropdownMenuTrigger asChild>
						<button
							type="button"
							disabled={disabled}
							aria-label={t("composer.effort.label")}
							className="flex h-7 min-w-0 max-w-[40%] shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
						>
							<span className="truncate">{selected?.name || value}</span>
							<ChevronDown className="size-3 shrink-0 opacity-70" />
						</button>
					</DropdownMenuTrigger>
				</TooltipTrigger>
				<TooltipContent>{t("composer.effort.label")}</TooltipContent>
			</Tooltip>
			<DropdownMenuContent align="start" className="min-w-28">
				<DropdownMenuRadioGroup value={value} onValueChange={onChange}>
					{options.map((effort) => (
						<DropdownMenuRadioItem key={effort.id} value={effort.id}>
							{effort.name || effort.id}
						</DropdownMenuRadioItem>
					))}
				</DropdownMenuRadioGroup>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
