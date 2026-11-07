import DataEditor, {
	AllCellRenderers,
	CompactSelection,
	type GridCell,
	GridCellKind,
	type GridColumn,
	GridColumnIcon,
	type GridSelection,
	type InnerGridCell,
	InnerGridCellKind,
	type InternalCellRenderer,
	type Item,
	type MarkerCell,
} from "@glideapps/glide-data-grid";
import "@glideapps/glide-data-grid/dist/index.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FieldCellEditor } from "@/components/research-table/field-cell-editor";
import { useGridTheme } from "@/components/research-table/use-grid-theme";
import { notifyError } from "@/lib/core/notify";
import { researchTableErrorMessage } from "@/lib/research-table/errors";
import {
	type CellValue,
	displayedColumnWidth,
	type ResearchTable,
	resizeColumn,
} from "@/lib/research-table/model";
import {
	applyViewEdits,
	applyViewPaste,
	registryChoices,
	rowLabel,
	type TableSort,
} from "@/lib/research-table/view";

export type TableRowRef = {
	index: number;
	id: string;
	label: string;
	archived: boolean;
};

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 34;

function scaledGridHeight(bodyRows: number, rem: number): number {
	const scale = rem > 0 ? rem / 16 : 1;
	const header = scale === 1 ? HEADER_HEIGHT : Math.ceil(HEADER_HEIGHT * scale);
	return Math.ceil(header + bodyRows * ROW_HEIGHT * scale);
}

function usePaneBox(active: boolean) {
	const ref = useRef<HTMLDivElement>(null);
	const [box, setBox] = useState({ available: 0, rem: 16 });
	useEffect(() => {
		if (!active) return;
		const parent = ref.current?.parentElement;
		if (!parent) return;
		const update = () =>
			setBox({
				available: parent.clientHeight,
				rem:
					Number.parseFloat(
						getComputedStyle(document.documentElement).fontSize,
					) || 16,
			});
		update();
		const observer = new ResizeObserver(update);
		observer.observe(parent);
		return () => observer.disconnect();
	}, [active]);
	return { ref, ...box };
}

function drawSortMark(
	ctx: CanvasRenderingContext2D,
	x: number,
	y: number,
	direction: "asc" | "desc",
	color: string,
) {
	ctx.save();
	ctx.strokeStyle = color;
	ctx.lineWidth = 1.25;
	ctx.lineCap = "round";
	ctx.lineJoin = "round";
	ctx.beginPath();
	if (direction === "asc") {
		ctx.moveTo(x - 3.5, y + 2);
		ctx.lineTo(x, y - 2.5);
		ctx.lineTo(x + 3.5, y + 2);
	} else {
		ctx.moveTo(x - 3.5, y - 2);
		ctx.lineTo(x, y + 2.5);
		ctx.lineTo(x + 3.5, y - 2);
	}
	ctx.stroke();
	ctx.restore();
}

const emptySelection = (): GridSelection => ({
	columns: CompactSelection.empty(),
	rows: CompactSelection.empty(),
});

function registryMarkerRenderer(
	renderer: InternalCellRenderer<InnerGridCell>,
	labelFor: (viewRow: number) => string,
): InternalCellRenderer<InnerGridCell> {
	return {
		...renderer,
		draw: (args, cell) => {
			if (cell.kind !== InnerGridCellKind.Marker) {
				renderer.draw(args, cell);
				return;
			}
			const labeled: MarkerCell = {
				...cell,
				// Glide stores a number and prints it. A string still renders.
				row: labelFor(args.row) as unknown as number,
			};
			renderer.draw({ ...args, cell: labeled }, labeled);
		},
		getAccessibilityString: (cell) =>
			cell.kind === InnerGridCellKind.Marker
				? labelFor(cell.row - 1)
				: renderer.getAccessibilityString(cell),
	};
}

export function TableGrid({
	table,
	onChange,
	onField,
	onAddField,
	onDeleteRows,
	onSortField,
	onRowSelection,
	rowIndexes,
	sort = null,
	query = "",
	showArchived = false,
	selectionEpoch = 0,
	height,
}: {
	table: ResearchTable;
	onChange?: (table: ResearchTable) => void;
	onField?: (index: number) => void;
	onAddField?: () => void;
	onDeleteRows?: (rows: TableRowRef[]) => void;
	onSortField?: (fieldId: string) => void;
	onRowSelection?: (rows: TableRowRef[]) => void;
	rowIndexes?: readonly number[];
	sort?: TableSort | null;
	query?: string;
	showArchived?: boolean;
	selectionEpoch?: number;
	height?: number;
}) {
	const theme = useGridTheme();
	const fitToPane = typeof height !== "number";
	const pane = usePaneBox(fitToPane);
	const indexes = useMemo(
		() => rowIndexes ?? table.rows.map((_, index) => index),
		[rowIndexes, table.rows],
	);
	const trailing = onChange ? 1 : 0;
	const bodyRows = indexes.length + trailing;
	const contentHeight = scaledGridHeight(bodyRows, pane.rem);
	const resolvedHeight =
		typeof height === "number"
			? height
			: pane.available > 0
				? Math.min(contentHeight, pane.available)
				: Math.min(contentHeight, 640);
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
	const [selection, setSelection] = useState<GridSelection>(emptySelection);
	const viewKey = `${query}\0${sort?.fieldId ?? ""}\0${sort?.direction ?? ""}\0${showArchived ? 1 : 0}\0${selectionEpoch}`;
	const [seenView, setSeenView] = useState(viewKey);
	if (seenView !== viewKey) {
		setSeenView(viewKey);
		setSelection(emptySelection());
	}
	const rowRef = useCallback(
		(view: number): TableRowRef | null => {
			const source = indexes[view];
			const row = source === undefined ? undefined : table.rows[source];
			if (source === undefined || !row) return null;
			return {
				index: source,
				id: row.id,
				label: rowLabel(table, source),
				archived: row.archivedAt !== undefined,
			};
		},
		[indexes, table],
	);
	const refsFrom = useCallback(
		(next: GridSelection) => {
			const refs: TableRowRef[] = [];
			for (let view = 0; view < indexes.length; view++) {
				if (!next.rows.hasIndex(view)) continue;
				const ref = rowRef(view);
				if (ref) refs.push(ref);
			}
			return refs;
		},
		[indexes.length, rowRef],
	);
	const links = useMemo(() => registryChoices(table), [table]);
	const rowMarkerWidth = useMemo(() => {
		let longest = 1;
		indexes.forEach((source, view) => {
			const label = table.rows[source]?.registryId || String(view + 1);
			longest = Math.max(longest, label.length);
		});
		return Math.min(168, Math.max(48, longest * 8 + 18));
	}, [indexes, table.rows]);
	const renderers =
		useMemo((): readonly InternalCellRenderer<InnerGridCell>[] => {
			const labelFor = (viewRow: number) => {
				const source = indexes[viewRow];
				return table.rows[source]?.registryId || String(viewRow + 1);
			};
			return AllCellRenderers.map((renderer) =>
				renderer.kind === InnerGridCellKind.Marker
					? registryMarkerRenderer(renderer, labelFor)
					: renderer,
			);
		}, [indexes, table.rows]);
	const columns = useMemo<GridColumn[]>(
		() => [
			...table.fields.map(
				(field): GridColumn => ({
					id: field.id,
					title: field.name,
					width: displayedColumnWidth(field),
					icon: {
						text: GridColumnIcon.HeaderString,
						number: GridColumnIcon.HeaderNumber,
						boolean: GridColumnIcon.HeaderBoolean,
						date: GridColumnIcon.HeaderDate,
						select: GridColumnIcon.HeaderSingleValue,
						link: GridColumnIcon.HeaderUri,
					}[field.type],
					hasMenu: !!onField,
					style: sort?.fieldId === field.id ? "highlight" : "normal",
				}),
			),
			...(onAddField && table.fields.length < 100
				? [{ id: "add-field", title: "+", width: 40 }]
				: []),
		],
		[table.fields, onField, onAddField, sort],
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
			const source = row < indexes.length ? indexes[row] : undefined;
			const value =
				source === undefined
					? null
					: (table.rows[source]?.values[field.id] ?? null);
			const common = { allowOverlay: true, readonly: !onChange };
			// Glide paints null and false as the same empty checkbox, and its
			// accessibility string calls both "false". Blank text keeps null empty
			// until the user commits true or false. Storage stays null.
			if (field.type === "boolean") {
				if (typeof value !== "boolean")
					return {
						...common,
						kind: GridCellKind.Text,
						data: "",
						displayData: "",
					};
				return {
					...common,
					kind: GridCellKind.Boolean,
					allowOverlay: false,
					data: value,
					contentAlign: "center",
				};
			}
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
		[table, onChange, indexes],
	);
	const paste = (target: Item, cells: readonly (readonly string[])[]) => {
		if (!onChange) return false;
		try {
			onChange(applyViewPaste(table, target[0], target[1], cells, indexes));
		} catch (error) {
			notifyError(researchTableErrorMessage(error));
		}
		return false;
	};
	const clearRange = (
		range: { x: number; y: number; width: number; height: number },
		edits: { col: number; viewRow: number; text: string }[],
	) => {
		for (let y = 0; y < range.height; y++) {
			const viewRow = range.y + y;
			if (viewRow >= indexes.length) continue;
			for (let x = 0; x < range.width; x++) {
				const col = range.x + x;
				if (!table.fields[col]) continue;
				edits.push({ col, viewRow, text: "" });
			}
		}
	};
	return (
		<div ref={pane.ref} className={fitToPane ? "h-full" : undefined}>
			<DataEditor
				theme={theme}
				width="100%"
				height={resolvedHeight}
				rows={bodyRows}
				scaleToRem
				rowHeight={ROW_HEIGHT}
				headerHeight={HEADER_HEIGHT}
				renderers={renderers}
				rowMarkers={
					onChange
						? { kind: "both", width: rowMarkerWidth, startIndex: 1 }
						: { kind: "number", width: rowMarkerWidth, startIndex: 1 }
				}
				columns={columns}
				onColumnResize={
					onChange
						? (_column, newSize, colIndex) => {
								const next = resizeColumn(table, colIndex, newSize);
								if (next !== table) onChange(next);
							}
						: undefined
				}
				getCellContent={getCellContent}
				getCellsForSelection={true}
				gridSelection={selection}
				onGridSelectionChange={(next) => {
					setSelection(next);
					onRowSelection?.(refsFrom(next));
				}}
				getRowThemeOverride={(row) => {
					const source = indexes[row];
					const archived =
						source !== undefined &&
						table.rows[source]?.archivedAt !== undefined;
					if (archived && theme?.bgCellMedium && theme.textLight)
						return {
							bgCell: theme.bgCellMedium,
							textDark: theme.textLight,
							textMedium: theme.textLight,
						};
					if (onChange && row === indexes.length && theme?.bgHeader)
						return { bgCell: theme.bgHeader };
					return undefined;
				}}
				onHeaderClicked={
					onChange || onAddField
						? (index) => {
								if (index === table.fields.length) onAddField?.();
								else if (onSortField && table.fields[index])
									onSortField(table.fields[index].id);
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
					const sorted =
						field && sort?.fieldId === field.id ? sort.direction : null;
					if (!field?.unit) drawContent();
					else {
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
						const sortSpace = sorted ? 14 : 0;
						ctx.font = `11px ${colors.fontFamily}`;
						const unitWidth = Math.min(
							ctx.measureText(field.unit).width,
							rect.width / 3,
						);
						const unitX =
							rect.x + rect.width - menuSpace - sortSpace - unitWidth;
						ctx.textBaseline = "middle";
						ctx.fillStyle = colors.textLight;
						ctx.fillText(
							field.unit,
							unitX,
							rect.y + rect.height / 2,
							unitWidth,
						);
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
					}
					if (sorted && field) {
						const menuSpace = args.column.hasMenu ? 26 : 10;
						drawSortMark(
							args.ctx,
							args.rect.x + args.rect.width - menuSpace - 7,
							args.rect.y + args.rect.height / 2,
							sorted,
							args.theme.accentColor,
						);
					}
				}}
				onPaste={paste}
				provideEditor={(cell) => {
					const index = selection.current?.cell[0];
					const field = index === undefined ? undefined : table.fields[index];
					const custom =
						field?.type === "date" ||
						field?.type === "select" ||
						(field?.type === "link" && !field.target);
					if (!field || !onChange || cell.kind !== GridCellKind.Text || !custom)
						return undefined;
					return {
						editor: (props) => (
							<FieldCellEditor
								{...props}
								field={field}
								links={field.type === "link" ? links : undefined}
							/>
						),
						disablePadding: true,
					};
				}}
				onDelete={(selected) => {
					if (!onChange) return false;
					if (selected.rows.length) {
						const requests = refsFrom(selected).filter((row) => !row.archived);
						if (requests.length) onDeleteRows?.(requests);
						return false;
					}
					const edits: { col: number; viewRow: number; text: string }[] = [];
					if (selected.current) {
						clearRange(selected.current.range, edits);
						for (const range of selected.current.rangeStack)
							clearRange(range, edits);
					}
					for (const col of selected.columns)
						clearRange(
							{ x: col, y: 0, width: 1, height: indexes.length },
							edits,
						);
					if (edits.length) {
						try {
							onChange(applyViewEdits(table, edits, indexes));
						} catch (error) {
							notifyError(researchTableErrorMessage(error));
						}
					}
					return false;
				}}
				onCellsEdited={
					onChange
						? (edits) => {
								try {
									const changes: {
										col: number;
										viewRow: number;
										text: string;
									}[] = [];
									for (const {
										location: [col, row],
										value,
									} of edits) {
										let scalar: CellValue;
										if (value.kind === GridCellKind.Boolean)
											scalar =
												typeof value.data === "boolean" ? value.data : null;
										else if (value.kind === GridCellKind.Number)
											scalar = value.data ?? null;
										else if (value.kind === GridCellKind.Text)
											scalar = value.data;
										else continue;
										changes.push({
											col,
											viewRow: row,
											text: scalar === null ? "" : String(scalar),
										});
									}
									if (changes.length)
										onChange(applyViewEdits(table, changes, indexes));
								} catch (error) {
									notifyError(researchTableErrorMessage(error));
								}
								return true;
							}
						: undefined
				}
			/>
		</div>
	);
}
