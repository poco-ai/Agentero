import { BookOpen, ChevronRight } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { PaperTitle } from "@/components/paper/paper-title";
import { Shimmer } from "@/components/ui/shimmer";
import { cn } from "@/lib/core/utils";
import type { PaperMetadata } from "@/lib/paper/types";

export function MobileLibraryPage({
	papers,
	loading,
	selected,
	onSelect,
	query,
}: {
	papers: PaperMetadata[];
	loading: boolean;
	selected: PaperMetadata | null;
	onSelect: (paper: PaperMetadata) => void;
	query: string;
}) {
	const { t } = useTranslation("mobile");
	const filtered = useMemo(() => {
		const normalized = query.trim().toLowerCase();
		if (!normalized) return papers;
		return papers.filter((paper) =>
			`${paper.title} ${paper.authors.join(" ")}`
				.toLowerCase()
				.includes(normalized),
		);
	}, [papers, query]);
	return (
		<section className="flex h-full min-h-0 select-none flex-col">
			<div className="agentero-scroll flex-1">
				{loading && papers.length === 0 ? (
					<div className="grid h-full place-items-center px-6">
						<Shimmer className="text-sm">{t("library.loading")}</Shimmer>
					</div>
				) : (
					<>
						<ul className="divide-y">
							{filtered.map((paper) => (
								<li key={paper.path ?? paper.id}>
									<button
										type="button"
										onClick={() => onSelect(paper)}
										className={cn(
											"flex w-full items-center gap-3 px-4 py-4.5 text-left md:px-6",
											selected?.id === paper.id && "bg-muted/60",
										)}
									>
										<div className="grid size-11 shrink-0 place-items-center rounded-lg border bg-muted text-muted-foreground">
											<BookOpen className="size-5" />
										</div>
										<span className="min-w-0 flex-1">
											<span className="line-clamp-2 block font-medium text-base leading-6">
												<PaperTitle text={paper.title} />
											</span>
											<span className="mt-1 block truncate text-muted-foreground text-sm">
												{paper.authors.join(", ")}
												{paper.year ? ` · ${paper.year}` : ""}
											</span>
										</span>
										<ChevronRight className="size-5 shrink-0 text-muted-foreground" />
									</button>
								</li>
							))}
						</ul>
						{filtered.length === 0 ? (
							<div className="grid h-full place-items-center text-muted-foreground text-sm">
								{t("library.empty")}
							</div>
						) : null}
					</>
				)}
			</div>
		</section>
	);
}
