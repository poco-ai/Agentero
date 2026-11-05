/**
 * Inline-editable Text Cell for custom paper properties.
 *
 * Click opens an input seeded with the current value; Enter / blur commits,
 * Escape reverts. A blank value clears the assignment. The commit is skipped
 * when nothing changed so a plain click never bumps `updated_at`.
 */
import { Pencil } from "lucide-react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/core/utils";
import {
	type CustomProperty,
	setPaperCustomProperty,
} from "@/lib/paper/custom-properties-store";

type TextCellProps = {
	paperPath: string;
	property: CustomProperty;
	value: string | undefined;
	className?: string;
};

export function TextCell({
	paperPath,
	property,
	value,
	className,
}: TextCellProps) {
	const { t } = useTranslation("sidebar");
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(value ?? "");
	const inputRef = useRef<HTMLInputElement>(null);
	/** Guards the blur that fires when the popover-less input unmounts. */
	const committedRef = useRef(false);

	useEffect(() => {
		if (!editing) setDraft(value ?? "");
	}, [editing, value]);

	useEffect(() => {
		if (editing) inputRef.current?.select();
	}, [editing]);

	const startEditing = () => {
		committedRef.current = false;
		setDraft(value ?? "");
		setEditing(true);
	};

	const commit = async () => {
		if (committedRef.current) return;
		committedRef.current = true;
		setEditing(false);
		const next = draft.trim();
		if (next === (value ?? "").trim()) return;
		await setPaperCustomProperty(paperPath, property.id, next || null);
	};

	const cancel = () => {
		committedRef.current = true;
		setDraft(value ?? "");
		setEditing(false);
	};

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
		e.stopPropagation();
		if (e.key === "Enter") {
			e.preventDefault();
			void commit();
		} else if (e.key === "Escape") {
			e.preventDefault();
			cancel();
		}
	};

	if (editing) {
		return (
			<input
				ref={inputRef}
				type="text"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={onKeyDown}
				onBlur={() => void commit()}
				onClick={(e) => e.stopPropagation()}
				onDoubleClick={(e) => e.stopPropagation()}
				className="w-full min-w-0 rounded-sm border border-ring bg-transparent px-1.5 py-0.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
				aria-label={property.name}
			/>
		);
	}

	return (
		<button
			type="button"
			onClick={(e) => {
				e.stopPropagation();
				startEditing();
			}}
			onDoubleClick={(e) => e.stopPropagation()}
			title={value || t("papersLibrary.customProperties.editTextValue")}
			aria-label={t("papersLibrary.customProperties.editTextValue")}
			className={cn(
				"group/text flex h-full w-full min-h-[1.75rem] cursor-text items-center gap-1 rounded-sm px-1.5 py-0.5 text-left text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
				className,
			)}
		>
			{value ? (
				<span className="truncate text-foreground">{value}</span>
			) : (
				<span className="text-muted-foreground/50 italic">-</span>
			)}
			<Pencil className="ml-auto size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/text:opacity-100" />
		</button>
	);
}
