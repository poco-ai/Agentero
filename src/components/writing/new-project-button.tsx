import { Plus } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { TreeRowActionButton } from "@/components/sidebar/tree-row-action-button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { NewProjectForm } from "./new-project-form";

export function NewProjectButton({
	vaultPath,
	parent,
}: {
	vaultPath: string;
	parent?: string;
}) {
	const { t } = useTranslation("sidebar");
	const [open, setOpen] = useState(false);
	return (
		<Popover open={open} onOpenChange={setOpen}>
			<TreeRowActionButton
				label={t("writing.newProject")}
				trigger={(button) => <PopoverTrigger asChild>{button}</PopoverTrigger>}
			>
				<Plus className="size-3.5" aria-hidden />
			</TreeRowActionButton>
			<PopoverContent align="start" className="w-72">
				<NewProjectForm
					vaultPath={vaultPath}
					parent={parent}
					startOpen
					onCreated={() => setOpen(false)}
				/>
			</PopoverContent>
		</Popover>
	);
}
