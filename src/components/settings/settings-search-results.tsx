import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
	PageTitle,
	settingsCardClassName,
} from "@/components/settings/settings-layout";
import type { SettingsSearchHit } from "@/components/settings/settings-search";
import { cn } from "@/lib/core/utils";

export function SettingsSearchResults({
	query,
	hits,
	onSelect,
}: {
	query: string;
	hits: SettingsSearchHit[];
	onSelect: (hit: SettingsSearchHit) => void;
}) {
	const { t } = useTranslation("settings");

	return (
		<div>
			<PageTitle title={t("search.resultsTitle", { query })} />
			{hits.length === 0 ? (
				<p className="rounded-xl border border-border/70 border-dashed px-3.5 py-6 text-center text-muted-foreground text-sm">
					{t("search.empty")}
				</p>
			) : (
				<div className={settingsCardClassName}>
					{hits.map((hit, index) => (
						<button
							key={`${hit.section}|${hit.labelKey}`}
							type="button"
							onClick={() => onSelect(hit)}
							className={cn(
								"group flex w-full items-center justify-between gap-3 px-3.5 py-3 text-left outline-none",
								"transition-colors duration-[var(--motion-duration-micro)] ease-[var(--motion-ease-out)]",
								"hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset",
								index > 0 && "border-border/50 border-t",
							)}
						>
							<span className="min-w-0">
								<span className="block truncate text-foreground text-sm leading-snug">
									{hit.label}
								</span>
								<span className="mt-0.5 block truncate text-muted-foreground text-xs leading-relaxed">
									{hit.path}
								</span>
							</span>
							<ArrowRight
								aria-hidden
								className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-focus-visible:opacity-100 group-hover:opacity-100"
							/>
						</button>
					))}
				</div>
			)}
		</div>
	);
}
