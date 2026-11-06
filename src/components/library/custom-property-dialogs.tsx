import { ChevronDown, Type } from "lucide-react";
import { useState } from "react";
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
import { cn } from "@/lib/core/utils";
import type {
	CustomProperty,
	PropertyType,
} from "@/lib/paper/custom-properties-store";
import {
	createCustomProperty,
	deleteCustomProperty,
	updateCustomProperty,
} from "@/lib/paper/custom-properties-store";

/** The two creatable property kinds, in picker order. */
const PROPERTY_TYPE_CHOICES = [
	{
		value: "select" as const,
		labelKey: "papersLibrary.customProperties.typeSelect" as const,
		icon: ChevronDown,
	},
	{
		value: "text" as const,
		labelKey: "papersLibrary.customProperties.typeText" as const,
		icon: Type,
	},
];

export function CreatePropertyDialog({
	open,
	onOpenChange,
	vaultPath,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	vaultPath?: string | null;
}) {
	const { t } = useTranslation("sidebar");
	const [name, setName] = useState("");
	const [type, setType] = useState<PropertyType>("select");
	const [submitting, setSubmitting] = useState(false);

	const handleCreate = async () => {
		const trimmed = name.trim();
		if (!trimmed) return;
		setSubmitting(true);
		try {
			await createCustomProperty(trimmed, type, [], vaultPath);
			setName("");
			setType("select");
			onOpenChange(false);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						{t("papersLibrary.customProperties.addProperty", "Add Property")}
					</DialogTitle>
					<DialogDescription>
						{t(
							"papersLibrary.customProperties.addPropertyDesc",
							"Create a new custom property for papers in your library.",
						)}
					</DialogDescription>
				</DialogHeader>
				<div className="flex flex-col gap-2 py-2">
					<Input
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void handleCreate();
						}}
						placeholder={t(
							"papersLibrary.customProperties.propertyNamePlaceholder",
							"Property name (e.g. Priority, Reading Status)",
						)}
						autoFocus
					/>
					{/* Type picker: two segmented buttons, no extra copy. */}
					<div className="flex items-center gap-1 rounded-md bg-muted/60 p-0.5">
						{PROPERTY_TYPE_CHOICES.map((choice) => (
							<button
								key={choice.value}
								type="button"
								aria-pressed={type === choice.value}
								className={cn(
									"flex flex-1 items-center justify-center gap-1.5 rounded px-2 py-1 text-xs transition-colors",
									type === choice.value
										? "bg-background font-medium text-foreground shadow-raised"
										: "text-muted-foreground hover:text-foreground",
								)}
								onClick={() => setType(choice.value)}
							>
								<choice.icon className="size-3.5" aria-hidden />
								<span>{t(choice.labelKey)}</span>
							</button>
						))}
					</div>
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={submitting}
					>
						{t("common.cancel", "Cancel")}
					</Button>
					<Button onClick={handleCreate} disabled={!name.trim() || submitting}>
						{t("common.create", "Create")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function RenamePropertyDialog({
	property,
	open,
	onOpenChange,
}: {
	property: CustomProperty | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useTranslation("sidebar");
	const [name, setName] = useState(property?.name ?? "");
	const [submitting, setSubmitting] = useState(false);

	const handleRename = async () => {
		if (!property) return;
		const trimmed = name.trim();
		if (!trimmed || trimmed === property.name) {
			onOpenChange(false);
			return;
		}
		setSubmitting(true);
		try {
			await updateCustomProperty({ ...property, name: trimmed });
			onOpenChange(false);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						{t(
							"papersLibrary.customProperties.renameProperty",
							"Rename Property",
						)}
					</DialogTitle>
				</DialogHeader>
				<div className="py-2">
					<Input
						value={name}
						onChange={(e) => setName(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") void handleRename();
						}}
						placeholder={property?.name}
						autoFocus
					/>
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={submitting}
					>
						{t("common.cancel", "Cancel")}
					</Button>
					<Button onClick={handleRename} disabled={!name.trim() || submitting}>
						{t("common.save", "Save")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

export function DeletePropertyDialog({
	property,
	open,
	onOpenChange,
}: {
	property: CustomProperty | null;
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	const { t } = useTranslation("sidebar");
	const [submitting, setSubmitting] = useState(false);

	const handleDelete = async () => {
		if (!property) return;
		setSubmitting(true);
		try {
			await deleteCustomProperty(property.id);
			onOpenChange(false);
		} finally {
			setSubmitting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>
						{t(
							"papersLibrary.customProperties.deleteProperty",
							"Delete Property",
						)}
					</DialogTitle>
					<DialogDescription>
						{t(
							"papersLibrary.customProperties.deletePropertyConfirm",
							`Are you sure you want to delete "${property?.name}"? All assigned values across your papers will be permanently removed.`,
							{ name: property?.name },
						)}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={submitting}
					>
						{t("common.cancel", "Cancel")}
					</Button>
					<Button
						variant="destructive"
						onClick={handleDelete}
						disabled={submitting}
					>
						{t("common.delete", "Delete")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
