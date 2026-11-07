import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export type OptionDraft = {
	id: string;
	value: string;
	from: string | null;
};

export function SelectOptionsEditor({
	labelId,
	options,
	onChange,
	onRemove,
}: {
	labelId: string;
	options: OptionDraft[];
	onChange: (options: OptionDraft[]) => void;
	onRemove: (option: OptionDraft) => void;
}) {
	const { t } = useTranslation("editor");
	const [focusId, setFocusId] = useState<string | null>(null);
	const move = (index: number, delta: number) => {
		const target = index + delta;
		if (target < 0 || target >= options.length) return;
		const next = options.slice();
		const [item] = next.splice(index, 1);
		if (!item) return;
		next.splice(target, 0, item);
		onChange(next);
	};
	return (
		<div className="grid gap-1.5">
			<span id={labelId}>{t("researchTable.options")}</span>
			<ul className="m-0 grid max-h-48 list-none gap-1.5 overflow-y-auto p-0">
				{options.map((option, index) => (
					<li key={option.id} className="flex items-center gap-1">
						<Input
							className="h-8 min-w-0"
							aria-label={t("researchTable.optionName", { index: index + 1 })}
							value={option.value}
							autoFocus={option.id === focusId}
							onChange={(event) =>
								onChange(
									options.map((item) =>
										item.id === option.id
											? { ...item, value: event.target.value }
											: item,
									),
								)
							}
						/>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t("researchTable.moveOptionUp")}
							disabled={index === 0}
							onClick={() => move(index, -1)}
						>
							<ChevronUp />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t("researchTable.moveOptionDown")}
							disabled={index === options.length - 1}
							onClick={() => move(index, 1)}
						>
							<ChevronDown />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							aria-label={t("researchTable.removeOption")}
							onClick={() => onRemove(option)}
						>
							<Trash2 />
						</Button>
					</li>
				))}
			</ul>
			<Button
				type="button"
				variant="outline"
				size="sm"
				className="justify-start"
				onClick={() => {
					const id = crypto.randomUUID();
					onChange([...options, { id, value: "", from: null }]);
					setFocusId(id);
				}}
			>
				<Plus />
				{t("researchTable.addOption")}
			</Button>
		</div>
	);
}
