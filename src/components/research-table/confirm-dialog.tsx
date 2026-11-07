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

export function ConfirmDialog({
	open,
	title,
	description,
	confirmLabel,
	destructive = false,
	onConfirm,
	onOpenChange,
}: {
	open: boolean;
	title: string;
	description: string;
	confirmLabel: string;
	destructive?: boolean;
	onConfirm: () => void;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useTranslation("editor");
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button variant="outline" onClick={() => onOpenChange(false)}>
						{t("researchTable.cancel")}
					</Button>
					<Button
						variant={destructive ? "destructive" : "default"}
						onClick={onConfirm}
					>
						{confirmLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
