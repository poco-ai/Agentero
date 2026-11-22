import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogClose,
	DialogContent,
	DialogFooter,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { errorText } from "@/lib/core/error";
import { notifyError } from "@/lib/core/notify";
import { confirmRenamePath, createVaultFolder } from "@/lib/vault/actions";
import { isValidVaultEntryName } from "@/lib/vault/path";
import { getVaultPath } from "@/lib/vault/store";

export type LibraryFolderDraft = { vaultPath: string } & (
	| { kind: "create"; parentPath: string }
	| { kind: "rename"; path: string; name: string }
);

export function LibraryFolderNameDialog({
	draft,
	onClose,
}: {
	draft: LibraryFolderDraft;
	onClose: () => void;
}) {
	const { t } = useTranslation(["sidebar", "common"]);
	const [name, setName] = useState(draft.kind === "rename" ? draft.name : "");
	const [submitting, setSubmitting] = useState(false);
	const title =
		draft.kind === "rename" ? t("fileTree.rename") : t("fileTree.newFolder");
	const submit = async () => {
		if (submitting || !name.trim() || getVaultPath() !== draft.vaultPath)
			return;
		if (!isValidVaultEntryName(name)) {
			notifyError(t("fileTree.invalidName"));
			return;
		}
		setSubmitting(true);
		try {
			if (draft.kind === "rename") {
				await confirmRenamePath(draft.path, name);
			} else {
				await createVaultFolder(draft.vaultPath, draft.parentPath, name);
			}
			onClose();
		} catch (error) {
			if (draft.kind === "create") notifyError(errorText(error));
		} finally {
			setSubmitting(false);
		}
	};
	return (
		<Dialog
			open
			onOpenChange={(open) => {
				if (!open && !submitting) onClose();
			}}
		>
			<DialogContent aria-describedby={undefined} showCloseButton={!submitting}>
				<DialogTitle>{title}</DialogTitle>
				<form
					className="grid gap-4"
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<Input
						aria-label={t("papersLibrary.folderName")}
						placeholder={t("papersLibrary.folderName")}
						value={name}
						onChange={(event) => setName(event.target.value)}
						disabled={submitting}
					/>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="outline" disabled={submitting}>
								{t("common:cancel")}
							</Button>
						</DialogClose>
						<Button type="submit" disabled={submitting || !name.trim()}>
							{title}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
