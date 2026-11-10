/**
 * Upload tab: connect GitHub and push one writing project without leaving the
 * canvas. The toolbar opens it when the project has no repository yet.
 */

import { useState } from "react";
import { useTranslation } from "react-i18next";
import { SiGithub } from "react-icons/si";
import { WritingSyncForm } from "@/components/writing/writing-sync-form";
import {
	useActiveWritingRoot,
	useWritingProjectRelative,
} from "@/hooks/use-writing-project";
import type { WritingGitHubLink } from "@/lib/writing/github";
import { uploadWritingProject } from "@/lib/writing/upload";

export function WritingSyncTab({
	vaultPath,
	showHeader = true,
}: {
	vaultPath: string;
	/** The dialog renders its own title and hint. */
	showHeader?: boolean;
}) {
	const { t } = useTranslation("sidebar");
	const activeRoot = useActiveWritingRoot();
	const project = useWritingProjectRelative(vaultPath, activeRoot);
	const [syncing, setSyncing] = useState(false);

	async function saveAndUpload(link: WritingGitHubLink) {
		if (!project) return;
		// Writes in this window do not fire a real storage event, but the
		// toolbar reads the link from storage and needs to refresh.
		window.dispatchEvent(new Event("storage"));
		setSyncing(true);
		try {
			await uploadWritingProject(project, link);
		} finally {
			setSyncing(false);
		}
	}

	const form = (
		<WritingSyncForm
			vaultPath={vaultPath}
			project={project}
			submitLabel={t("writing.syncSave")}
			busy={syncing}
			onSaved={(link) => void saveAndUpload(link)}
		/>
	);

	if (!showHeader) return form;

	return (
		<div className="h-full overflow-y-auto">
			<div className="mx-auto flex w-full max-w-md flex-col px-6 py-8">
				<h2 className="flex items-center gap-2 font-semibold text-base">
					<SiGithub
						className="size-4 shrink-0 text-muted-foreground"
						aria-hidden
					/>
					{t("writing.syncSetup")}
				</h2>
				<p className="mt-2 mb-6 text-muted-foreground text-sm leading-relaxed">
					{t("writing.syncSetupHint")}
				</p>
				{form}
			</div>
		</div>
	);
}
