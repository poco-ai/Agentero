import { FileText, FolderPlus } from "lucide-react";
import {
	type ReactNode,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useImeGuard } from "@/hooks/use-ime-guard";
import { cn } from "@/lib/core/utils";
import { hasVaultFileExtension, isValidVaultEntryName } from "@/lib/vault";
import type { TreeCreateKind } from "./types";

type NameInputProps = {
	initialName: string;
	icon: ReactNode;
	label: string;
	selectBasename?: boolean;
	unchangedName?: string;
	onConfirm: (name: string) => void;
	onCancel: () => void;
};

function TreeNameInput({
	initialName,
	icon,
	label,
	selectBasename = false,
	unchangedName,
	onConfirm,
	onCancel,
}: NameInputProps) {
	const { t } = useTranslation("sidebar");
	const { isBlockedByIme, compositionProps } = useImeGuard();
	const [value, setValue] = useState(initialName);
	const [error, setError] = useState<string | null>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const committedRef = useRef(false);

	useEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.focus();
		const dot = initialName.lastIndexOf(".");
		if (selectBasename && dot > 0) el.setSelectionRange(0, dot);
		else el.select();
	}, [initialName, selectBasename]);

	const cancel = useCallback(() => {
		if (committedRef.current) return;
		committedRef.current = true;
		onCancel();
	}, [onCancel]);

	const commit = useCallback(() => {
		if (committedRef.current) return;
		// Read the final DOM value, including composition updates before a blur.
		const name = (inputRef.current?.value ?? value).trim();
		if (!name) {
			cancel();
			return;
		}
		if (!isValidVaultEntryName(name)) {
			setError(t("fileTree.invalidName"));
			requestAnimationFrame(() => inputRef.current?.focus());
			return;
		}
		if (name === unchangedName) {
			cancel();
			return;
		}
		committedRef.current = true;
		onConfirm(name);
	}, [value, unchangedName, cancel, onConfirm, t]);

	// Keep the row height fixed so virtualized drafts leave no gap when removed.
	return (
		<div className="relative">
			<div
				className={cn(
					"flex h-7 items-center gap-1 rounded pl-2.5 pr-4",
					error ? "bg-destructive/10" : "bg-muted/60",
				)}
			>
				{icon}
				<input
					ref={inputRef}
					type="text"
					value={value}
					title={error ?? undefined}
					aria-label={label}
					aria-invalid={Boolean(error)}
					className={cn(
						"h-5 min-w-0 flex-1 rounded-sm border border-ring bg-background px-1 text-sm outline-none",
						error && "border-destructive",
					)}
					onChange={(e) => {
						setValue(e.target.value);
						if (error) setError(null);
					}}
					onKeyDown={(e) => {
						e.stopPropagation();
						if (isBlockedByIme(e)) return;
						if (e.key === "Enter") {
							e.preventDefault();
							commit();
						} else if (e.key === "Escape") {
							e.preventDefault();
							cancel();
						}
					}}
					onBlur={() => {
						// Let composition updates and Enter/click handlers finish first.
						requestAnimationFrame(commit);
					}}
					{...compositionProps}
				/>
			</div>
			{error ? (
				<p className="pointer-events-none absolute top-full right-0 left-8 z-10 mt-0.5 rounded bg-background/95 px-1 text-destructive text-caption leading-tight shadow-sm">
					{error}
				</p>
			) : null}
		</div>
	);
}

/** Inline name input — VS Code / Cursor style create. */
export function TreeCreateInput({
	kind,
	onConfirm,
	onCancel,
}: {
	kind: TreeCreateKind;
	onConfirm: (name: string) => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation("sidebar");
	const Icon = kind === "file" ? FileText : FolderPlus;
	return (
		<TreeNameInput
			initialName={
				kind === "file" ? `${t("fileTree.untitledNote")}.md` : "New Folder"
			}
			icon={<Icon className="size-4 shrink-0 text-muted-foreground" />}
			label={kind === "file" ? t("fileTree.newFile") : t("fileTree.newFolder")}
			selectBasename={kind === "file"}
			onConfirm={(name) =>
				onConfirm(
					kind === "file" && !hasVaultFileExtension(name) ? `${name}.md` : name,
				)
			}
			onCancel={onCancel}
		/>
	);
}

/** Inline name input for renaming a file/folder (VS Code / Finder style). */
export function TreeRenameInput({
	initialName,
	icon,
	onConfirm,
	onCancel,
}: {
	initialName: string;
	icon: ReactNode;
	onConfirm: (name: string) => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation("sidebar");
	return (
		<TreeNameInput
			initialName={initialName}
			icon={icon}
			label={t("fileTree.rename")}
			unchangedName={initialName}
			onConfirm={onConfirm}
			onCancel={onCancel}
		/>
	);
}
