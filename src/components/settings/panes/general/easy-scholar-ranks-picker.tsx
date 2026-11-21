/**
 * Dropdown that selects which EasyScholar rank systems the Library table and
 * Paper Info display. Tags are stored for every system by the Host, so this is
 * a display-only filter: toggling never refetches or rewrites metadata.
 */
import { Check, ChevronDown, RotateCcw } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/core/utils";
import {
	DEFAULT_EASY_SCHOLAR_RANKS,
	EASY_SCHOLAR_RANK_IDS,
	type EasyScholarRankId,
} from "@/lib/paper/easy-scholar-ranks";

const TRIGGER_CLASS =
	"flex min-h-8 w-full min-w-0 flex-1 flex-wrap items-center gap-1 rounded-lg border border-input bg-transparent px-1.5 py-1 text-left text-xs outline-none transition-colors hover:bg-muted/30 focus-visible:border-ring dark:bg-input/30";

export function EasyScholarRanksPicker({
	ranks,
	onChange,
}: {
	ranks: readonly EasyScholarRankId[];
	onChange: (next: EasyScholarRankId[]) => void;
}) {
	const { t } = useTranslation("settings");
	const selected = new Set(ranks);
	const isDefault =
		ranks.length === DEFAULT_EASY_SCHOLAR_RANKS.length &&
		DEFAULT_EASY_SCHOLAR_RANKS.every((id) => selected.has(id));

	const toggle = (id: EasyScholarRankId) => {
		onChange(
			EASY_SCHOLAR_RANK_IDS.filter((candidate) =>
				candidate === id ? !selected.has(id) : selected.has(candidate),
			),
		);
	};

	return (
		<Popover>
			<PopoverTrigger asChild>
				<button id="easy-scholar-ranks" type="button" className={TRIGGER_CLASS}>
					{ranks.length ? (
						ranks.map((id) => (
							<span
								key={id}
								className="rounded bg-muted px-1.5 py-0.5 text-caption text-muted-foreground leading-none"
							>
								{t(`general.easyScholar.rankNames.${id}`)}
							</span>
						))
					) : (
						<span className="px-1 text-muted-foreground/60">
							{t("general.easyScholar.ranksPlaceholder")}
						</span>
					)}
					<ChevronDown
						className="ml-auto size-3.5 shrink-0 text-muted-foreground"
						aria-hidden
					/>
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-56 p-1.5"
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				<div className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
					{EASY_SCHOLAR_RANK_IDS.map((id) => {
						const on = selected.has(id);
						return (
							<button
								key={id}
								type="button"
								aria-pressed={on}
								className={cn(
									"flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs",
									"hover:bg-muted/60",
									on && "bg-muted/50",
								)}
								onClick={() => toggle(id)}
							>
								<span
									className={cn(
										"flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
										on
											? "border-primary bg-primary text-primary-foreground"
											: "border-muted-foreground/40",
									)}
									aria-hidden
								>
									{on ? <Check className="size-3.5" /> : null}
								</span>
								<span className="truncate">
									{t(`general.easyScholar.rankNames.${id}`)}
								</span>
							</button>
						);
					})}
				</div>
				{isDefault ? null : (
					<>
						<div className="my-1.5 h-px bg-border" />
						<button
							type="button"
							className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1 text-muted-foreground text-xs hover:bg-muted/60 hover:text-foreground"
							onClick={() => onChange([...DEFAULT_EASY_SCHOLAR_RANKS])}
						>
							<RotateCcw className="size-3" aria-hidden />
							{t("general.easyScholar.ranksReset")}
						</button>
					</>
				)}
			</PopoverContent>
		</Popover>
	);
}
