import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import type { WikiHeadingAnchor } from "@/lib/wiki-heading-rename";

export type HeadingRenameDialogProps = {
	open: boolean;
	heading: WikiHeadingAnchor | null;
	busy: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: (newText: string) => void | Promise<void>;
};

export function HeadingRenameDialog({
	open,
	heading,
	busy,
	onOpenChange,
	onConfirm,
}: HeadingRenameDialogProps) {
	const { t } = useTranslation("editor");
	const [value, setValue] = useState("");

	useEffect(() => {
		if (open && heading) setValue(heading.text);
	}, [heading, open]);

	const trimmed = value.trim();
	const invalid =
		!trimmed ||
		trimmed === heading?.text ||
		value.includes("\n") ||
		value.includes("\r");

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!busy) onOpenChange(next);
			}}
		>
			<DialogContent
				showCloseButton={!busy}
				className="sm:max-w-sm"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					window.requestAnimationFrame(() => {
						document
							.querySelector<HTMLInputElement>(
								'[data-heading-rename-input="true"]',
							)
							?.select();
					});
				}}
			>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						if (!invalid && !busy) void onConfirm(trimmed);
					}}
				>
					<DialogHeader>
						<DialogTitle>{t("headingRename.title")}</DialogTitle>
						<DialogDescription>
							{t("headingRename.description")}
						</DialogDescription>
					</DialogHeader>
					<div className="py-4">
						<label
							htmlFor="heading-rename-input"
							className="mb-1.5 block font-medium text-xs"
						>
							{t("headingRename.label")}
						</label>
						<Input
							id="heading-rename-input"
							data-heading-rename-input="true"
							value={value}
							disabled={busy}
							onChange={(event) => setValue(event.target.value)}
							aria-invalid={value.includes("\n") || value.includes("\r")}
						/>
					</div>
					<DialogFooter>
						<Button
							type="button"
							variant="outline"
							disabled={busy}
							onClick={() => onOpenChange(false)}
						>
							{t("headingRename.cancel")}
						</Button>
						<Button type="submit" disabled={invalid || busy}>
							{busy ? t("headingRename.renaming") : t("headingRename.confirm")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	);
}
