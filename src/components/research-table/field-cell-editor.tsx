import type {
	GridCell,
	ProvideEditorComponent,
} from "@glideapps/glide-data-grid";
import { useEffect, useId, useRef } from "react";
import { useImeGuard } from "@/hooks/use-ime-guard";
import type { TableField } from "@/lib/research-table/model";

type Props = Parameters<ProvideEditorComponent<GridCell>>[0] & {
	field: TableField;
	links?: readonly { id: string; text: string }[];
};

export function FieldCellEditor({
	value,
	onChange,
	onFinishedEditing,
	field,
	links,
}: Props) {
	const listId = useId();
	const control = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
	const { compositionProps, isBlockedByIme } = useImeGuard();
	useEffect(() => control.current?.focus(), []);
	if (value.kind !== "text") return null;
	const change = (data: string) => ({ ...value, data, displayData: data });
	if (field.type === "select")
		return (
			<select
				ref={(node) => {
					control.current = node;
				}}
				aria-label={field.name}
				className="h-9 w-full bg-background px-2 text-foreground"
				value={value.data}
				onKeyDown={(event) => event.stopPropagation()}
				onChange={(event) => onFinishedEditing(change(event.target.value))}
			>
				<option value="">—</option>
				{field.options.map((option) => (
					<option key={option} value={option}>
						{option}
					</option>
				))}
			</select>
		);
	if (field.type === "link")
		return (
			<>
				<input
					ref={(node) => {
						control.current = node;
					}}
					aria-label={field.name}
					list={listId}
					className="h-9 w-full bg-background px-2 text-foreground"
					value={value.data}
					{...compositionProps}
					onChange={(event) => {
						const data = event.target.value;
						onChange(change(data));
						if (links?.some((item) => item.id === data))
							onFinishedEditing(change(data));
					}}
					onKeyDown={(event) => {
						event.stopPropagation();
						if (isBlockedByIme(event)) return;
						if (event.key === "Enter") {
							event.preventDefault();
							onFinishedEditing(change(event.currentTarget.value));
						}
						if (event.key === "Escape") {
							event.preventDefault();
							onFinishedEditing();
						}
					}}
				/>
				<datalist id={listId}>
					{links?.map((item) => (
						<option
							key={item.id}
							value={item.id}
							label={item.text || item.id}
						/>
					))}
				</datalist>
			</>
		);
	return (
		<input
			ref={(node) => {
				control.current = node;
			}}
			aria-label={field.name}
			type="date"
			className="h-9 w-full bg-background px-2 text-foreground"
			value={value.data}
			{...compositionProps}
			onChange={(event) => onChange(change(event.target.value))}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (isBlockedByIme(event)) return;
				if (event.key === "Enter") {
					event.preventDefault();
					onFinishedEditing(change(event.currentTarget.value));
				}
				if (event.key === "Escape") {
					event.preventDefault();
					onFinishedEditing();
				}
			}}
		/>
	);
}
