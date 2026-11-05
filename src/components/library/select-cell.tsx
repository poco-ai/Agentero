/**
 * Interactive Select Cell for custom paper properties.
 * Displays option badge/chip. On click, opens popover with search,
 * create-option, and option selection/clear.
 */
import { Check, ChevronDown, Plus, Search, Trash2, X } from "lucide-react";
import { type MouseEvent, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/core/utils";
import type { CustomProperty } from "@/lib/paper/custom-properties-store";
import {
	createOptionAndSetCustomProperty,
	deleteCustomPropertyOption,
	setPaperCustomProperty,
	useCustomProperties,
} from "@/lib/paper/custom-properties-store";
import {
	TAG_COLOR_IDS,
	type TagColorId,
	tagChipStyle,
	tagSwatchStyle,
} from "@/lib/ui/tag-colors";

type SelectCellProps = {
	paperPath: string;
	property: CustomProperty;
	selectedOptionId: string | undefined;
	className?: string;
};

export function SelectCell({
	paperPath,
	property: initialProperty,
	selectedOptionId,
	className,
}: SelectCellProps) {
	const { t } = useTranslation("sidebar");
	const allProps = useCustomProperties();
	const property =
		allProps.find((p) => p.id === initialProperty.id) ?? initialProperty;
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");
	const [selectedColor, setSelectedColor] = useState<string | null>(null);

	const selectedOption = useMemo(
		() => property.options.find((o) => o.id === selectedOptionId),
		[property.options, selectedOptionId],
	);

	const filteredOptions = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return property.options;
		return property.options.filter((o) => o.name.toLowerCase().includes(q));
	}, [property.options, search]);

	const canCreate = useMemo(() => {
		const q = search.trim();
		if (!q) return false;
		return !property.options.some(
			(o) => o.name.toLowerCase() === q.toLowerCase(),
		);
	}, [property.options, search]);

	const handleSelect = async (
		e: MouseEvent<HTMLElement>,
		optId: string | null,
	) => {
		e.stopPropagation();
		await setPaperCustomProperty(paperPath, property.id, optId);
		setOpen(false);
		setSearch("");
	};

	const handleCreate = async (e: MouseEvent<HTMLElement>) => {
		e.stopPropagation();
		const name = search.trim();
		if (!name) return;
		await createOptionAndSetCustomProperty(
			paperPath,
			property.id,
			name,
			selectedColor,
		);
		setOpen(false);
		setSearch("");
		setSelectedColor(null);
	};

	const handleDeleteOption = async (
		e: MouseEvent<HTMLElement>,
		optId: string,
	) => {
		e.stopPropagation();
		await deleteCustomPropertyOption(property.id, optId);
	};

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<button
					type="button"
					onClick={(e) => {
						e.stopPropagation();
					}}
					className={cn(
						"group/select flex h-full w-full min-h-[1.75rem] cursor-pointer items-center justify-between gap-1 rounded-sm px-1.5 py-0.5 text-xs transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
						className,
					)}
				>
					{selectedOption ? (
						<span
							className="inline-flex max-w-full items-center gap-1.5 truncate rounded-full px-2 py-0.5 font-medium text-xs"
							style={tagChipStyle(selectedOption.color as TagColorId | null)}
						>
							{selectedOption.color ? (
								<span
									className="size-1.5 shrink-0 rounded-full"
									style={tagSwatchStyle(
										selectedOption.color as TagColorId | null,
									)}
								/>
							) : null}
							<span className="truncate">{selectedOption.name}</span>
						</span>
					) : (
						<span className="text-muted-foreground/50 text-xs italic">-</span>
					)}
					<ChevronDown className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/select:opacity-100" />
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-56 p-1.5 text-xs"
				onClick={(e) => e.stopPropagation()}
				onOpenAutoFocus={(e) => e.preventDefault()}
			>
				{/* Search box */}
				<div className="mb-1 flex items-center gap-1.5 border-b px-1 pb-1.5">
					<Search className="size-3 shrink-0 text-muted-foreground" />
					<input
						type="text"
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								if (canCreate) {
									void handleCreate(e as unknown as MouseEvent<HTMLElement>);
								} else if (filteredOptions.length === 1) {
									void handleSelect(
										e as unknown as MouseEvent<HTMLElement>,
										filteredOptions[0].id,
									);
								}
							}
						}}
						placeholder={t("papersLibrary.customProperties.searchOrAddOption")}
						className="w-full bg-transparent text-xs placeholder:text-muted-foreground/60 focus:outline-none"
					/>
					{search ? (
						<button
							type="button"
							onClick={() => setSearch("")}
							className="text-muted-foreground hover:text-foreground"
						>
							<X className="size-3" />
						</button>
					) : null}
				</div>

				{/* Create option button if not found */}
				{canCreate ? (
					<div className="mb-1 flex flex-col gap-1.5 rounded bg-muted/40 p-1">
						<button
							type="button"
							onClick={handleCreate}
							className="flex items-center gap-1.5 text-left font-medium text-primary text-xs hover:underline"
						>
							<Plus className="size-3" />
							<span>
								{t("papersLibrary.customProperties.createOption")} "
								{search.trim()}"
							</span>
						</button>
						<div className="flex items-center gap-1 pt-0.5">
							{TAG_COLOR_IDS.map((c) => (
								<button
									key={c}
									type="button"
									onClick={() =>
										setSelectedColor(selectedColor === c ? null : c)
									}
									className={cn(
										"size-3 rounded-full transition-transform",
										selectedColor === c && "scale-125 ring-1 ring-ring",
									)}
									style={tagSwatchStyle(c)}
									title={c}
								/>
							))}
						</div>
					</div>
				) : null}

				{/* Options list */}
				<div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
					{filteredOptions.length === 0 && !canCreate ? (
						<div className="py-2 text-center text-muted-foreground text-xs">
							{t("papersLibrary.customProperties.noOptions")}
						</div>
					) : (
						filteredOptions.map((opt) => {
							const isSelected = opt.id === selectedOptionId;
							return (
								<button
									type="button"
									key={opt.id}
									onClick={(e) => handleSelect(e, opt.id)}
									className={cn(
										"group/opt flex w-full cursor-pointer items-center justify-between gap-1.5 rounded-md px-2 py-1.5 text-left text-xs hover:bg-muted",
										isSelected && "bg-muted font-medium",
									)}
								>
									<span
										className="inline-flex max-w-[140px] items-center gap-1.5 truncate rounded-full px-2 py-0.5 text-xs"
										style={tagChipStyle(opt.color as TagColorId | null)}
									>
										{opt.color ? (
											<span
												className="size-1.5 shrink-0 rounded-full"
												style={tagSwatchStyle(opt.color as TagColorId | null)}
											/>
										) : null}
										<span className="truncate">{opt.name}</span>
									</span>
									<div className="flex shrink-0 items-center gap-1">
										{isSelected ? (
											<Check className="size-3 text-primary" />
										) : null}
										<button
											type="button"
											onClick={(e) => handleDeleteOption(e, opt.id)}
											className="p-0.5 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover/opt:opacity-100"
											title={t("papersLibrary.customProperties.deleteOption")}
										>
											<Trash2 className="size-3" />
										</button>
									</div>
								</button>
							);
						})
					)}
				</div>

				{/* Clear value button */}
				{selectedOptionId ? (
					<>
						<div className="my-1 border-t" />
						<button
							type="button"
							onClick={(e) => handleSelect(e, null)}
							className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-muted-foreground text-xs hover:bg-muted hover:text-foreground"
						>
							<X className="size-3" />
							<span>{t("papersLibrary.customProperties.clearValue")}</span>
						</button>
					</>
				) : null}
			</PopoverContent>
		</Popover>
	);
}
