/**
 * 广场（Plaza）center panel: one embedded source per tab.
 *
 * The tree root node is a plain virtual folder (expand/collapse only) with no
 * page of its own; each child row opens its source's tab. Everything is
 * derived from the {@link PLAZA_SOURCES} registry, so a new source needs no
 * changes here.
 */

import { useTranslation } from "react-i18next";
import { PlazaArxivRecView } from "@/components/plaza/plaza-arxiv-rec-view";
import { PlazaCcfDeadlinesView } from "@/components/plaza/plaza-ccf-deadlines-view";
import { PlazaFeedsView } from "@/components/plaza/plaza-feeds-view";
import { PlazaSkillsView } from "@/components/plaza/plaza-skills-view";
import { PlazaWebFrame } from "@/components/plaza/plaza-web-frame";
import { cn } from "@/lib/core/utils";
import { plazaSourceForPath, plazaSourceLabel } from "@/lib/plaza";

export function PlazaView({
	path,
	className,
}: {
	path: string;
	className?: string;
}) {
	const { t } = useTranslation("sidebar");
	const source = plazaSourceForPath(path);

	if (source?.panel === "skills") {
		return <PlazaSkillsView className={className} />;
	}

	if (source?.panel === "feeds") {
		return <PlazaFeedsView className={className} />;
	}

	if (source?.panel === "arxivRec") {
		return <PlazaArxivRecView className={className} />;
	}

	if (source?.panel === "ccfDeadlines") {
		return <PlazaCcfDeadlinesView className={className} />;
	}

	if (source?.url) {
		return (
			<PlazaWebFrame
				homeUrl={source.url}
				embedOrigin={source.embedOrigin?.() ?? null}
				lastPathStorageKey={
					source.embedOrigin
						? `agentero:plaza:${source.id}:last-path`
						: undefined
				}
				title={plazaSourceLabel(source)}
				className={className}
			/>
		);
	}

	if (source) {
		return (
			<div
				className={cn(
					"flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm",
					className,
				)}
			>
				{t("plaza.comingSoonFor", { label: plazaSourceLabel(source) })}
			</div>
		);
	}

	// The Plaza root has no page of its own — it is a tree folder only.
	return null;
}
