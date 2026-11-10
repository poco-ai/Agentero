/**
 * Name, template, and create one writing project on the project home.
 */

import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { notifyError } from "@/lib/core/notify";
import { openWritingFile } from "@/lib/workspace/navigation";
import {
	isWritingCompiler,
	WRITING_COMPILERS,
	type WritingCompiler,
} from "@/lib/writing/project-manifest";
import { createWritingProject } from "@/lib/writing/projects";
import {
	isWritingTemplateId,
	WRITING_TEMPLATE_IDS,
	type WritingTemplateId,
} from "@/lib/writing/templates";

export function NewProjectForm({
	vaultPath,
	parent,
	startOpen = false,
	onCreated,
}: {
	vaultPath: string;
	parent?: string;
	startOpen?: boolean;
	onCreated?: () => void;
}) {
	const { t } = useTranslation("sidebar");
	const [open, setOpen] = useState(startOpen);
	const [name, setName] = useState("");
	const templateId = useId();
	const compilerId = useId();
	const [template, setTemplate] = useState<WritingTemplateId>("blank");
	const [compiler, setCompiler] = useState<WritingCompiler | "template">(
		"template",
	);
	const [busy, setBusy] = useState(false);

	const submit = async () => {
		if (busy) return;
		setBusy(true);
		try {
			const result = await createWritingProject(
				vaultPath,
				name,
				template,
				parent,
				compiler === "template" ? undefined : compiler,
			);
			if (!result.ok) {
				if (result.reason === "invalid") notifyError(t("fileTree.invalidName"));
				else if (result.reason === "exists") {
					notifyError(t("fileTree.alreadyExists", { name: name.trim() }));
				} else notifyError(result.message || t("writing.createFailed"));
				return;
			}
			openWritingFile(result.rootFile, result.rootFile);
			setName("");
			if (!startOpen) setOpen(false);
			onCreated?.();
		} finally {
			setBusy(false);
		}
	};

	if (!open) {
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="text-muted-foreground hover:text-foreground flex h-7 w-full items-center rounded-md px-2 text-left text-xs outline-none hover:bg-sidebar-accent/80 focus-visible:ring-1 focus-visible:ring-ring/60"
			>
				{t("writing.newProject")}
			</button>
		);
	}

	return (
		<form
			className="flex flex-col gap-1.5"
			onSubmit={(event) => {
				event.preventDefault();
				void submit();
			}}
		>
			<div className="flex flex-col gap-1">
				<label htmlFor={templateId} className="text-muted-foreground text-xs">
					{t("writing.template")}
				</label>
				<Select
					value={template}
					disabled={busy}
					onValueChange={(value) => {
						if (isWritingTemplateId(value)) setTemplate(value);
					}}
				>
					<SelectTrigger id={templateId} className="h-8 w-full text-sm">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						{WRITING_TEMPLATE_IDS.map((id) => (
							<SelectItem key={id} value={id}>
								{t(`writing.templates.${id}`)}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="flex flex-col gap-1">
				<label htmlFor={compilerId} className="text-muted-foreground text-xs">
					{t("writing.compiler")}
				</label>
				<Select
					value={compiler}
					disabled={busy}
					onValueChange={(value) => {
						if (value === "template" || isWritingCompiler(value))
							setCompiler(value);
					}}
				>
					<SelectTrigger id={compilerId} className="h-8 w-full text-sm">
						<SelectValue />
					</SelectTrigger>
					<SelectContent>
						<SelectItem value="template">
							{t("writing.templateCompiler")}
						</SelectItem>
						{WRITING_COMPILERS.map((engine) => (
							<SelectItem key={engine} value={engine}>
								{engine}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="flex items-center gap-1.5">
				<Input
					value={name}
					disabled={busy}
					placeholder={t("writing.projectName")}
					aria-label={t("writing.projectName")}
					onChange={(event) => setName(event.target.value)}
					className="h-8 min-w-0 flex-1 text-sm"
				/>
				<Button
					type="submit"
					size="sm"
					disabled={busy || name.trim().length === 0}
				>
					{t("writing.create")}
				</Button>
			</div>
		</form>
	);
}
