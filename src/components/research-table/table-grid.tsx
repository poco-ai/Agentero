import DataEditor, {
	CompactSelection,
	type GridCell,
	GridCellKind,
	type GridSelection,
	type Item,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useTheme } from "next-themes";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FieldCellEditor } from "@/components/research-table/field-cell-editor";
import { notifyError } from "@/lib/core/notify";
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
	height = 420,
}: {
	table: ResearchTable;
	onChange?: (table: ResearchTable) => void;
	onField?: (index: number) => void;
	height?: number | string;
}) {
	const { t } = useTranslation("editor");
	const { resolvedTheme } = useTheme();
	const theme = useMemo(
		() =>
			resolvedTheme === "dark"
				? {
						bgCell: "#171717",
						bgCellMedium: "#202020",
						bgHeader: "#202020",
						bgHeaderHovered: "#303030",
						bgHeaderHasFocus: "#303030",
						bgBubble: "#303030",
						textDark: "#ededed",
						textMedium: "#b4b4b4",
						textLight: "#909090",
						textHeader: "#ededed",
						borderColor: "#353535",
						horizontalBorderColor: "#353535",
					}
				: undefined,
		[resolvedTheme],
	);
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
	const columns = useMemo(
		() =>
			table.fields.map((f) => ({
				id: f.id,
				title: f.unit ? `${f.name} (${f.unit})` : f.name,
				width: 180,
			})),
		[table.fields],
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
			notifyError(
				t("researchTable.invalid", {
					detail: error instanceof Error ? error.message : String(error),
				}),
			);
		}
		return false;
	};
	return (
		<DataEditor
			theme={theme}
			width="100%"
			height={height}
			rows={table.rows.length}
			rowMarkers={onChange ? "both" : "number"}
			columns={columns}
			getCellContent={getCellContent}
			getCellsForSelection={true}
			gridSelection={selection}
			onGridSelectionChange={setSelection}
			onHeaderClicked={onChange ? onField : undefined}
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
								notifyError(
									t("researchTable.invalid", {
										detail:
											error instanceof Error ? error.message : String(error),
									}),
								);
							}
							return true;
						}
					: undefined
			}
		/>
	);
}
