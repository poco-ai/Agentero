/**
 * 广场（Plaza）center panel: one native view or embedded source per tab.
 * Each child row opens its source's tab. The Plaza root only expands or collapses.
 */

import { useTranslation } from "react-i18next";
import { PlazaArxivRecView } from "@/components/plaza/plaza-arxiv-rec-view";
import { PlazaCcfDeadlinesView } from "@/components/plaza/plaza-ccf-deadlines-view";
import { PlazaFeedsView } from "@/components/plaza/plaza-feeds-view";
import { PlazaHuggingFaceView } from "@/components/plaza/plaza-huggingface-view";
import { PlazaSkillsView } from "@/components/plaza/plaza-skills-view";
import { PlazaWebFrame } from "@/components/plaza/plaza-web-frame";
import { EmptyState } from "@/components/ui/empty-state";
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

	if (source?.panel === "huggingface") {
		return <PlazaHuggingFaceView className={className} />;
	}

	if (source?.panel === "ccfDeadlines") {
		return <PlazaCcfDeadlinesView className={className} />;
	}

	if (source?.url) {
		return (
			<PlazaWebFrame
				homeUrl={source.url}
				desktopWidth={source.desktopWidth}
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
			<EmptyState className={className}>
				{t("plaza.comingSoonFor", { label: plazaSourceLabel(source) })}
			</EmptyState>
		);
	}

	// The Plaza root has no page of its own — it is a tree folder only.
	return null;
}
