import { Settings2 } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { TreeRowActionButton } from "@/components/sidebar/tree-row-action-button";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { joinVaultPath } from "@/lib/vault/path";
import { openWritingFile } from "@/lib/workspace/navigation";
import {
	type ExplicitWritingProject,
	explicitWritingProjectForPath,
	hasWritingMainFile,
	isWritingCompiler,
	parseWritingManifest,
	WRITING_COMPILERS,
	writeWritingManifest,
} from "@/lib/writing/project-manifest";
import { copyWritingProject } from "@/lib/writing/projects";
import { bumpWritingTreeRevision } from "@/lib/writing/tree-target";

export function ProjectSettingsButton({
	vault,
	project,
}: {
	vault: string;
	project: ExplicitWritingProject;
}) {
	const { t } = useTranslation("sidebar");
	const [open, setOpen] = useState(false);
	const [copyName, setCopyName] = useState<string | null>(null);
	const [draft, setDraft] = useState(project.manifest);
	const [busy, setBusy] = useState(false);
	const nameId = useId();
	const mainId = useId();
	const compilerId = useId();

	async function save() {
		if (busy) return;
		setBusy(true);
		try {
			const current = await explicitWritingProjectForPath(
				vault,
				project.directory,
				true,
			);
			if (current?.manifest.projectId !== project.manifest.projectId)
				throw new Error(t("writing.invalidProjectConfig"));
			const manifest = parseWritingManifest(JSON.stringify(draft));
			const candidate = {
				...current,
				manifest,
				root: joinVaultPath(current.directory, manifest.mainFile),
			};
			if (!(await hasWritingMainFile(vault, candidate)))
				throw new Error(t("writing.missingMainFile"));
			await writeWritingManifest(current.directory, manifest);
			bumpWritingTreeRevision();
			setOpen(false);
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setBusy(false);
		}
	}

	async function copy() {
		if (busy || copyName === null) return;
		setBusy(true);
		try {
			const result = await copyWritingProject(vault, project, copyName);
			if (!result.ok) {
				notifyError(
					result.reason === "exists"
						? t("fileTree.alreadyExists", { name: copyName.trim() })
						: result.message || t("writing.createFailed"),
				);
				return;
			}
			setOpen(false);
			openWritingFile(result.rootFile, result.rootFile);
		} finally {
			setBusy(false);
		}
	}

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (next) {
					setDraft(project.manifest);
					setCopyName(null);
				}
				setOpen(next);
			}}
		>
			<TreeRowActionButton
				label={t("writing.projectSettings")}
				trigger={(button) => <DialogTrigger asChild>{button}</DialogTrigger>}
			>
				<Settings2 className="size-3.5" aria-hidden />
			</TreeRowActionButton>
			<DialogContent className="sm:max-w-sm">
				<DialogTitle>
					{t(
						copyName === null
							? "writing.projectSettings"
							: "writing.copyProject",
					)}
				</DialogTitle>
				{copyName !== null ? (
					<form
						className="flex flex-col gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							void copy();
						}}
					>
						<label htmlFor={nameId}>{t("writing.projectName")}</label>
						<Input
							id={nameId}
							value={copyName}
							onChange={(event) => setCopyName(event.target.value)}
						/>
						<DialogFooter>
							<Button type="submit" disabled={busy || !copyName.trim()}>
								{t("writing.create")}
							</Button>
						</DialogFooter>
					</form>
				) : (
					<form
						className="flex flex-col gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							void save();
						}}
					>
						<label htmlFor={nameId}>{t("writing.projectName")}</label>
						<Input
							id={nameId}
							value={draft.name}
							onChange={(event) =>
								setDraft({ ...draft, name: event.target.value })
							}
						/>
						<label htmlFor={mainId}>{t("writing.mainFile")}</label>
						<Input
							id={mainId}
							value={draft.mainFile}
							onChange={(event) =>
								setDraft({ ...draft, mainFile: event.target.value })
							}
						/>
						<label htmlFor={compilerId}>{t("writing.compiler")}</label>
						<Select
							value={draft.compiler}
							onValueChange={(value) => {
								if (isWritingCompiler(value))
									setDraft({ ...draft, compiler: value });
							}}
						>
							<SelectTrigger id={compilerId}>
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{WRITING_COMPILERS.map((engine) => (
									<SelectItem key={engine} value={engine}>
										{engine}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								disabled={busy}
								onClick={() =>
									setCopyName(
										t("writing.copyName", { name: project.manifest.name }),
									)
								}
							>
								{t("writing.copyProject")}
							</Button>
							<Button type="submit" disabled={busy}>
								{t("writing.projectSave")}
							</Button>
						</DialogFooter>
					</form>
				)}
			</DialogContent>
		</Dialog>
	);
}
