import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
	EXPERIMENT_STATUSES,
	type ExperimentStatus,
} from "@/lib/markdown/experiment";

export function ExperimentStatusMenu({
	status,
	onChange,
}: {
	status: ExperimentStatus | null;
	onChange: (status: ExperimentStatus) => void;
}) {
	const { t } = useTranslation("editor");
	const label = status
		? t(`experiment.status.${status}`)
		: t("experiment.status.missing");
	return (
		<div className="flex h-8 shrink-0 items-center border-b border-border/60 bg-background px-3">
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						variant="outline"
						size="sm"
						className="h-6 gap-1 px-2 text-xs"
						aria-label={t("experiment.statusLabel")}
					>
						{label}
						<ChevronDown className="size-3" aria-hidden />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="start">
					<DropdownMenuRadioGroup
						value={status ?? ""}
						onValueChange={(value) => {
							if (EXPERIMENT_STATUSES.includes(value as ExperimentStatus)) {
								onChange(value as ExperimentStatus);
							}
						}}
					>
						{EXPERIMENT_STATUSES.map((item) => (
							<DropdownMenuRadioItem key={item} value={item}>
								{t(`experiment.status.${item}`)}
							</DropdownMenuRadioItem>
						))}
					</DropdownMenuRadioGroup>
				</DropdownMenuContent>
			</DropdownMenu>
		</div>
	);
}
