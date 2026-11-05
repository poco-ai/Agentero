import DataEditor, {
	CompactSelection,
	type GridCell,
	GridCellKind,
	type GridColumn,
	GridColumnIcon,
	type GridSelection,
	type Item,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { FieldCellEditor } from "@/components/research-table/field-cell-editor";
import { useGridTheme } from "@/components/research-table/use-grid-theme";
import { notifyError } from "@/lib/core/notify";
import { researchTableErrorMessage } from "@/lib/research-table/errors";
import {
	type CellValue,
	editCells,
	pasteCells,
	type ResearchTable,
} from "@/lib/research-table/model";

export function TableGrid({
	table,
	onChange,
	onField,
	onAddField,
	height = 420,
}: {
	table: ResearchTable;
	onChange?: (table: ResearchTable) => void;
	onField?: (index: number) => void;
	onAddField?: () => void;
	height?: number | string;
}) {
	const theme = useGridTheme();
	useEffect(() => {
		// Glide's public overlay contract requires one window-level portal.
		if (document.getElementById("portal")) return;
		const portal = document.createElement("div");
		portal.id = "portal";
		Object.assign(portal.style, {
			position: "fixed",
			left: "0",
			top: "0",
			zIndex: "9999",
		});
		document.body.append(portal);
	}, []);
	const [selection, setSelection] = useState<GridSelection>({
		columns: CompactSelection.empty(),
		rows: CompactSelection.empty(),
	});
	const columns = useMemo<GridColumn[]>(
		() => [
			...table.fields.map((f) => ({
				id: f.id,
				title: f.name,
				width: f.unit ? 220 : 200,
				icon: {
					text: GridColumnIcon.HeaderString,
					number: GridColumnIcon.HeaderNumber,
					boolean: GridColumnIcon.HeaderBoolean,
					date: GridColumnIcon.HeaderDate,
					select: GridColumnIcon.HeaderSingleValue,
				}[f.type],
				hasMenu: !!onField,
			})),
			...(onAddField && table.fields.length < 100
				? [{ id: "add-field", title: "+", width: 40 }]
				: []),
		],
		[table.fields, onField, onAddField],
	);
	const getCellContent = useCallback(
		([col, row]: Item): GridCell => {
			const field = table.fields[col];
			if (!field)
				return {
					kind: GridCellKind.Text,
					data: "",
					displayData: "",
					allowOverlay: false,
					readonly: true,
				};
			const value = table.rows[row]?.values[field.id] ?? null;
			const common = { allowOverlay: true, readonly: !onChange };
			if (field.type === "boolean")
				return {
					...common,
					kind: GridCellKind.Boolean,
					allowOverlay: false,
					data: typeof value === "boolean" ? value : null,
				};
			if (field.type === "number")
				return {
					...common,
					kind: GridCellKind.Number,
					data: typeof value === "number" ? value : undefined,
					displayData: value === null ? "" : String(value),
					allowNegative: true,
					contentAlign: "right",
				};
			return {
				...common,
				kind: GridCellKind.Text,
				data: value === null ? "" : String(value),
				displayData: value === null ? "" : String(value),
			};
		},
		[table, onChange],
	);
	const paste = (target: Item, cells: readonly (readonly string[])[]) => {
		if (!onChange) return false;
		try {
			onChange(pasteCells(table, target[0], target[1], cells));
		} catch (error) {
			notifyError(researchTableErrorMessage(error));
		}
		return false;
	};
	return (
		<DataEditor
			theme={theme}
			width="100%"
			height={height}
			rows={table.rows.length}
			scaleToRem
			rowHeight={32}
			headerHeight={34}
			rowMarkerWidth={42}
			rowMarkers={onChange ? "both" : "number"}
			columns={columns}
			getCellContent={getCellContent}
			getCellsForSelection={true}
			gridSelection={selection}
			onGridSelectionChange={setSelection}
			onHeaderClicked={
				onChange
					? (index) => {
							if (index === table.fields.length) onAddField?.();
							else onField?.(index);
						}
					: undefined
			}
			onHeaderMenuClick={onChange ? onField : undefined}
			drawHeader={(args, drawContent) => {
				const field = table.fields[args.columnIndex];
				if (!field && onAddField) {
					const { ctx, rect, theme: colors } = args;
					ctx.save();
					ctx.strokeStyle = colors.textLight;
					ctx.lineWidth = 1.25;
					const x = rect.x + rect.width / 2,
						y = rect.y + rect.height / 2;
					ctx.beginPath();
					ctx.moveTo(x - 4, y);
					ctx.lineTo(x + 4, y);
					ctx.moveTo(x, y - 4);
					ctx.lineTo(x, y + 4);
					ctx.stroke();
					ctx.restore();
					return;
				}
				if (!field?.unit) {
					drawContent();
					return;
				}
				const { ctx, rect, theme: colors, column, spriteManager } = args;
				ctx.save();
				ctx.beginPath();
				ctx.rect(rect.x + 1, rect.y + 1, rect.width - 2, rect.height - 2);
				ctx.clip();
				if (column.icon)
					spriteManager.drawSprite(
						column.icon,
						"normal",
						ctx,
						rect.x + 10,
						rect.y + (rect.height - 16) / 2,
						16,
						colors,
					);
				const menuSpace = column.hasMenu ? 26 : 10;
				ctx.font = `11px ${colors.fontFamily}`;
				const unitWidth = Math.min(
					ctx.measureText(field.unit).width,
					rect.width / 3,
				);
				const unitX = rect.x + rect.width - menuSpace - unitWidth;
				ctx.textBaseline = "middle";
				ctx.fillStyle = colors.textLight;
				ctx.fillText(field.unit, unitX, rect.y + rect.height / 2, unitWidth);
				ctx.save();
				ctx.beginPath();
				ctx.rect(
					rect.x + 34,
					rect.y,
					Math.max(0, unitX - rect.x - 42),
					rect.height,
				);
				ctx.clip();
				ctx.font = `${colors.headerFontStyle} ${colors.fontFamily}`;
				ctx.fillStyle = colors.textHeader;
				ctx.fillText(field.name, rect.x + 34, rect.y + rect.height / 2);
				ctx.restore();
				if (column.hasMenu && args.isHovered) {
					ctx.strokeStyle = colors.textLight;
					ctx.lineWidth = 1;
					const x = rect.x + rect.width - 15,
						y = rect.y + rect.height / 2;
					ctx.beginPath();
					ctx.moveTo(x - 3, y - 1);
					ctx.lineTo(x, y + 2);
					ctx.lineTo(x + 3, y - 1);
					ctx.stroke();
				}
				ctx.restore();
			}}
			onPaste={paste}
			provideEditor={(cell) => {
				const index = selection.current?.cell[0];
				const field = index === undefined ? undefined : table.fields[index];
				if (
					!onChange ||
					cell.kind !== GridCellKind.Text ||
					!field ||
					!["date", "select"].includes(field.type)
				)
					return undefined;
				return {
					editor: (props) => <FieldCellEditor {...props} field={field} />,
					disablePadding: true,
				};
			}}
			onDelete={(selected) => {
				if (!onChange) return false;
				if (selected.rows.length) {
					onChange({
						...table,
						rows: table.rows.filter(
							(_, index) => !selected.rows.hasIndex(index),
						),
					});
					setSelection({
						columns: CompactSelection.empty(),
						rows: CompactSelection.empty(),
					});
					return false;
				}
				return true;
			}}
			onCellsEdited={
				onChange
					? (edits) => {
							try {
								const changes: { col: number; row: number; text: string }[] =
									[];
								// All values validate before the shared snapshot is published.
								for (const {
									location: [col, row],
									value,
								} of edits) {
									let scalar: CellValue;
									if (value.kind === GridCellKind.Boolean)
										scalar = value.data ?? null;
									else if (value.kind === GridCellKind.Number)
										scalar = value.data ?? null;
									else if (value.kind === GridCellKind.Text)
										scalar = value.data;
									else continue;
									changes.push({
										col,
										row,
										text: scalar === null ? "" : String(scalar),
									});
								}
								onChange(editCells(table, changes));
							} catch (error) {
								notifyError(researchTableErrorMessage(error));
							}
							return true;
						}
					: undefined
			}
		/>
	);
}
