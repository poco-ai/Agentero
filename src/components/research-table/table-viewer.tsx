import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/research-table/confirm-dialog";
import {
	type OptionDraft,
	SelectOptionsEditor,
} from "@/components/research-table/select-options-editor";
import {
	TableGrid,
	type TableRowRef,
} from "@/components/research-table/table-grid";
import {
	TableBacklinks,
	type TableSaveState,
	TableToolbar,
} from "@/components/research-table/table-toolbar";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { isImeKeyboardEvent } from "@/lib/core/ime";
import { notifyError } from "@/lib/core/notify";
import { researchTableErrorMessage } from "@/lib/research-table/errors";
import { safeTableReference } from "@/lib/research-table/markdown";
import {
	appendRows,
	archiveRows,
	duplicateRows,
	fieldChangeNeedsMigration,
	fieldTypes,
	optionUsage,
	parseResearchTable,
	type ResearchTable,
	removeField,
	removeRows,
	replaceField,
	restoreRows,
	type TableField,
} from "@/lib/research-table/model";
import {
	cycleSort,
	type TableSort,
	visibleRowIndexes,
} from "@/lib/research-table/view";
import { notifyWikiEmbedTargets } from "@/lib/wiki/embed-refresh";
import { registerTextEditorFlusher } from "@/lib/workspace/text-editor-flush";

type Props = {
	path: string;
	seed: string;
	reloadKey: number;
	onPersist: (
		path: string,
		content: string,
		lastSaved: string,
	) => Promise<boolean>;
	onDirtyChange: (dirty: boolean) => void;
	vaultPath: string | null;
};
function readTable(source: string): {
	table: ResearchTable | null;
	error: unknown;
} {
	try {
		return { table: parseResearchTable(source), error: null };
	} catch (error) {
		return { table: null, error };
	}
}

function shortTableError(error: unknown): string {
	return researchTableErrorMessage(error).split("\n")[0]?.slice(0, 180) ?? "";
}

function draftsFrom(field: TableField): OptionDraft[] {
	return field.options.map((value) => ({
		id: crypto.randomUUID(),
		value,
		from: value,
	}));
}

function invalidOptions(drafts: readonly OptionDraft[]): boolean {
	const values = drafts.map((draft) => draft.value.trim());
	return (
		!values.length ||
		values.some((value) => !value) ||
		new Set(values).size !== values.length
	);
}

function clipLabel(label: string): string {
	return label.length > 80 ? `${label.slice(0, 79)}…` : label;
}

export function TableViewer({
	path,
	seed,
	reloadKey,
	onPersist,
	onDirtyChange,
	vaultPath,
}: Props) {
	const { t } = useTranslation("editor");
	const formId = useId();
	const lastReload = useRef(reloadKey);
	const [table, setTable] = useState<ResearchTable | null>(
		() => readTable(seed).table,
	);
	const [readError, setReadError] = useState<unknown>(
		() => readTable(seed).error,
	);
	const [query, setQuery] = useState("");
	const [sort, setSort] = useState<TableSort | null>(null);
	const [showArchived, setShowArchived] = useState(false);
	const [selectedRows, setSelectedRows] = useState<TableRowRef[]>([]);
	const [selectionEpoch, setSelectionEpoch] = useState(0);
	const [optionDrafts, setOptionDrafts] = useState<OptionDraft[]>([]);
	const [optionMessage, setOptionMessage] = useState<string | null>(null);
	const [pendingRows, setPendingRows] = useState<TableRowRef[] | null>(null);
	const [pendingPermanent, setPendingPermanent] = useState<
		TableRowRef[] | null
	>(null);
	const [pendingFieldDelete, setPendingFieldDelete] = useState(false);
	const current = useRef(table);
	current.current = table;
	const saved = useRef(seed);
	const savedRevision = useRef(table?.revision ?? 0);
	const dirty = useRef(false);
	const callbacks = useRef({ onPersist, onDirtyChange, path });
	callbacks.current = { onPersist, onDirtyChange, path };
	const history = useRef<ResearchTable[]>([]),
		future = useRef<ResearchTable[]>([]);
	const saving = useRef<Promise<boolean> | null>(null);
	const [saveState, setSaveState] = useState<TableSaveState>("saved");
	const [field, setField] = useState<TableField | null>(null);
	const setSnapshot = useCallback((next: ResearchTable) => {
		if (current.current === next) return;
		current.current = next;
		setTable(next);
		dirty.current = true;
		setSaveState("pending");
		callbacks.current.onDirtyChange(true);
	}, []);
	const change = useCallback(
		(next: ResearchTable) => {
			if (current.current === next) return;
			if (current.current)
				history.current = [...history.current.slice(-19), current.current];
			future.current = [];
			setSnapshot(next);
		},
		[setSnapshot],
	);
	const clearRowSelection = useCallback(() => {
		setSelectedRows([]);
		setSelectionEpoch((epoch) => epoch + 1);
	}, []);
	const onRowSelection = useCallback((rows: TableRowRef[]) => {
		setSelectedRows(rows);
	}, []);
	const undo = useCallback(
		(forward = false) => {
			const from = forward ? future.current : history.current;
			const next = from.pop();
			if (!next || !current.current) return;
			(forward ? history.current : future.current).push(current.current);
			setSnapshot(next);
		},
		[setSnapshot],
	);
	const flush = useCallback(async (): Promise<boolean> => {
		if (saving.current) {
			if (!(await saving.current)) return false;
		}
		const snapshot = current.current;
		if (!dirty.current || !snapshot) return true;
		const revision = savedRevision.current + 1;
		const content = `${JSON.stringify({ ...snapshot, revision }, null, 2)}\n`;
		setSaveState("saving");
		const attempt = callbacks.current.onPersist(
			callbacks.current.path,
			content,
			saved.current,
		);
		saving.current = attempt;
		try {
			const ok = await attempt;
			if (ok) {
				saved.current = content;
				savedRevision.current = revision;
				if (current.current === snapshot) {
					dirty.current = false;
					callbacks.current.onDirtyChange(false);
				}
				notifyWikiEmbedTargets([callbacks.current.path]);
			}
			setSaveState(ok ? (dirty.current ? "pending" : "saved") : "error");
			return ok;
		} finally {
			if (saving.current === attempt) saving.current = null;
		}
	}, []);
	useEffect(() => registerTextEditorFlusher(path, flush), [path, flush]);
	useEffect(() => {
		if (
			(seed === saved.current && lastReload.current === reloadKey) ||
			dirty.current
		)
			return;
		lastReload.current = reloadKey;
		const next = readTable(seed);
		current.current = next.table;
		setTable(next.table);
		setReadError(next.error);
		saved.current = seed;
		savedRevision.current = next.table?.revision ?? 0;
		history.current = [];
		future.current = [];
		setSaveState("saved");
	}, [seed, reloadKey]);
	useEffect(() => {
		if (!table || !dirty.current) return;
		const timer = setTimeout(() => {
			void flush();
		}, 800);
		return () => clearTimeout(timer);
	}, [table, flush]);
	useEffect(
		() => () => {
			void flush();
		},
		[flush],
	);
	const [viewPath, setViewPath] = useState(path);
	const selectionView = `${query}\0${sort?.fieldId ?? ""}\0${sort?.direction ?? ""}\0${showArchived ? 1 : 0}\0${selectionEpoch}`;
	const [seenSelectionView, setSeenSelectionView] = useState(selectionView);
	if (seenSelectionView !== selectionView) {
		setSeenSelectionView(selectionView);
		setSelectedRows([]);
	}
	if (viewPath !== path) {
		setViewPath(path);
		setQuery("");
		setSort(null);
		setShowArchived(false);
		setSelectedRows([]);
	}
	const rowIndexes = useMemo(
		() =>
			table ? visibleRowIndexes(table, { query, sort, showArchived }) : [],
		[table, query, sort, showArchived],
	);
	const editField = (next: TableField) => {
		setField(next);
		setOptionDrafts(draftsFrom(next));
		setOptionMessage(null);
		setPendingFieldDelete(false);
	};
	if (!table)
		return (
			<div className="grid gap-1 p-4" role="alert">
				<p className="text-muted-foreground">
					{t("researchTable.invalidFile")}
				</p>
				{readError ? (
					<p className="text-sm text-foreground">
						{shortTableError(readError)}
					</p>
				) : null}
			</div>
		);
	const migrationBlocked = field
		? fieldChangeNeedsMigration(table, field)
		: false;
	const linkTargetInvalid =
		field?.type === "link" &&
		!!field.target?.trim() &&
		!safeTableReference(field.target.trim());
	const archivedCount = table.rows.reduce(
		(count, row) => count + (row.archivedAt ? 1 : 0),
		0,
	);
	const archivedSelected = selectedRows.filter((row) => row.archived);
	const optionsBlocked =
		field?.type === "select" && invalidOptions(optionDrafts);
	const rowCount = pendingRows?.length ?? 0;
	const soleRow = rowCount === 1 ? pendingRows?.[0] : undefined;
	const fail = (error: unknown) =>
		notifyError(researchTableErrorMessage(error));
	return (
		<section
			className="@container flex h-full min-h-0 flex-col"
			aria-label={table.name}
			onKeyDownCapture={(event) => {
				if (isImeKeyboardEvent(event)) return;
				if (!(event.metaKey || event.ctrlKey)) return;
				if (event.key.toLowerCase() === "s") {
					event.preventDefault();
					void flush();
				}
				if (
					event.key.toLowerCase() === "z" &&
					!(
						event.target instanceof HTMLElement &&
						(event.target.isContentEditable ||
							event.target.closest("input,textarea"))
					)
				) {
					event.preventDefault();
					event.stopPropagation();
					undo(event.shiftKey);
				}
			}}
		>
			<TableToolbar
				table={table}
				path={path}
				vaultPath={vaultPath}
				onChange={change}
				saveState={saveState}
				onSave={() => void flush()}
				canUndo={!!history.current.length}
				onAddField={() =>
					editField({
						id: crypto.randomUUID(),
						name: "",
						type: "text",
						unit: "",
						options: [],
					})
				}
				canRedo={!!future.current.length}
				onUndo={undo}
				query={query}
				onQueryChange={setQuery}
				visibleRows={rowIndexes.length}
				showArchived={showArchived}
				onShowArchived={setShowArchived}
				canManageArchived={archivedSelected.length > 0}
				onRestoreArchived={() => {
					change(
						restoreRows(
							table,
							archivedSelected.map((row) => row.index),
						),
					);
					clearRowSelection();
				}}
				onDeleteArchived={() => setPendingPermanent(archivedSelected)}
				onAddRows={(count) => {
					try {
						change(appendRows(table, count));
					} catch (error) {
						fail(error);
					}
				}}
				selectedRows={selectedRows}
				onDuplicateRows={(indexes) => {
					try {
						change(duplicateRows(table, indexes));
					} catch (error) {
						fail(error);
					}
				}}
			/>
			<div className="min-h-0 flex-1 overflow-hidden border-y border-border/60 bg-background">
				<TableGrid
					table={table}
					onChange={change}
					rowIndexes={rowIndexes}
					sort={sort}
					query={query}
					showArchived={showArchived}
					selectionEpoch={selectionEpoch}
					onRowSelection={onRowSelection}
					onSortField={(fieldId) =>
						setSort((currentSort) => cycleSort(currentSort, fieldId))
					}
					onDeleteRows={setPendingRows}
					onField={(index) => {
						const next = table.fields[index];
						if (next) editField({ ...next });
					}}
					onAddField={() =>
						editField({
							id: crypto.randomUUID(),
							name: "",
							type: "text",
							unit: "",
							options: [],
						})
					}
				/>
			</div>
			<footer className="flex h-7 shrink-0 items-center gap-2 px-4 text-[0.6875rem] tabular-nums text-muted-foreground">
				<span>
					{t("researchTable.dimensions", {
						rows: table.rows.length - archivedCount,
						columns: table.fields.length,
					})}
				</span>
				{archivedCount > 0 ? (
					<span>
						{t("researchTable.archivedCount", { count: archivedCount })}
					</span>
				) : null}
				<TableBacklinks tableId={table.id} path={path} vaultPath={vaultPath} />
			</footer>
			<Dialog
				open={field !== null}
				onOpenChange={(open) => {
					if (!open) setField(null);
				}}
			>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{t("researchTable.field")}</DialogTitle>
					</DialogHeader>
					{field && (
						<form
							className="grid gap-3"
							onSubmit={(event) => {
								event.preventDefault();
								if (migrationBlocked || optionsBlocked || linkTargetInvalid)
									return;
								const drafts = optionDrafts.map((draft) => ({
									...draft,
									value: draft.value.trim(),
								}));
								const renames: Record<string, string> = {};
								if (field.type === "select")
									for (const draft of drafts)
										if (draft.from && draft.from !== draft.value)
											renames[draft.from] = draft.value;
								try {
									change(
										replaceField(
											table,
											{
												...field,
												options:
													field.type === "select"
														? drafts.map((draft) => draft.value)
														: [],
											},
											renames,
										),
									);
									setField(null);
								} catch (error) {
									fail(error);
								}
							}}
						>
							<label htmlFor={`${formId}-name`}>
								{t("researchTable.name")}
								<Input
									id={`${formId}-name`}
									value={field.name}
									required
									maxLength={120}
									onChange={(e) => setField({ ...field, name: e.target.value })}
								/>
							</label>
							<label htmlFor={`${formId}-type`} className="grid gap-1.5">
								{t("researchTable.type")}
								<Select
									value={field.type}
									onValueChange={(type) =>
										setField({ ...field, type: type as TableField["type"] })
									}
								>
									<SelectTrigger id={`${formId}-type`} className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{fieldTypes.map((type) => (
											<SelectItem key={type} value={type}>
												{t(`researchTable.types.${type}`)}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</label>
							{field.type === "link" && (
								<label htmlFor={`${formId}-target`}>
									{t("researchTable.linkTarget")}
									<Input
										id={`${formId}-target`}
										value={field.target ?? ""}
										placeholder="data/other.table.json"
										onChange={(e) =>
											setField({ ...field, target: e.target.value })
										}
									/>
								</label>
							)}
							{field.type === "number" && (
								<label htmlFor={`${formId}-unit`}>
									{t("researchTable.unit")}
									<Input
										id={`${formId}-unit`}
										value={field.unit}
										onChange={(e) =>
											setField({ ...field, unit: e.target.value })
										}
									/>
								</label>
							)}
							{field.type === "select" && (
								<SelectOptionsEditor
									labelId={`${formId}-options`}
									options={optionDrafts}
									onChange={(next) => {
										setOptionDrafts(next);
										setOptionMessage(null);
									}}
									onRemove={(option) => {
										if (option.from) {
											const count = optionUsage(table, field.id, option.from);
											if (count > 0) {
												setOptionMessage(
													t("researchTable.optionInUse", {
														count,
														option: option.from,
													}),
												);
												return;
											}
										}
										setOptionDrafts((currentDrafts) =>
											currentDrafts.filter((item) => item.id !== option.id),
										);
										setOptionMessage(null);
									}}
								/>
							)}
							{migrationBlocked ? (
								<p className="text-sm text-destructive" role="status">
									{t("researchTable.migrationBlocked")}
								</p>
							) : null}
							{linkTargetInvalid ? (
								<p className="text-sm text-destructive" role="status">
									{t("researchTable.errors.path")}
								</p>
							) : null}
							{field.type === "select" && (optionMessage || optionsBlocked) ? (
								<p className="text-sm text-destructive" role="status">
									{optionMessage ?? t("researchTable.optionInvalid")}
								</p>
							) : null}
							<DialogFooter>
								{table.fields.some((item) => item.id === field.id) ? (
									<Button
										type="button"
										variant="destructive"
										disabled={table.fields.length === 1}
										onClick={() => setPendingFieldDelete(true)}
									>
										{t("researchTable.deleteField")}
									</Button>
								) : null}
								<Button
									type="submit"
									disabled={
										migrationBlocked || optionsBlocked || linkTargetInvalid
									}
								>
									{t("researchTable.save")}
								</Button>
							</DialogFooter>
						</form>
					)}
				</DialogContent>
			</Dialog>
			<ConfirmDialog
				open={pendingRows !== null}
				title={t("researchTable.deleteRowsTitle")}
				description={
					soleRow?.label
						? t("researchTable.deleteRowNamed", {
								label: clipLabel(soleRow.label),
							})
						: t("researchTable.deleteRowsBody", { count: rowCount })
				}
				confirmLabel={t("researchTable.deleteRows")}
				destructive
				onOpenChange={(open) => {
					if (!open) setPendingRows(null);
				}}
				onConfirm={() => {
					if (!pendingRows) return;
					try {
						change(
							archiveRows(
								table,
								pendingRows.map((row) => row.index),
							),
						);
						clearRowSelection();
						setPendingRows(null);
					} catch (error) {
						fail(error);
					}
				}}
			/>
			<ConfirmDialog
				open={pendingPermanent !== null}
				title={t("researchTable.permanentDeleteTitle")}
				description={
					pendingPermanent?.length === 1 && pendingPermanent[0]?.label
						? t("researchTable.permanentDeleteNamed", {
								label: clipLabel(pendingPermanent[0].label),
							})
						: t("researchTable.permanentDeleteBody", {
								count: pendingPermanent?.length ?? 0,
							})
				}
				confirmLabel={t("researchTable.deletePermanently")}
				destructive
				onOpenChange={(open) => {
					if (!open) setPendingPermanent(null);
				}}
				onConfirm={() => {
					if (!pendingPermanent) return;
					try {
						change(
							removeRows(
								table,
								pendingPermanent.map((row) => row.index),
							),
						);
						clearRowSelection();
						setPendingPermanent(null);
					} catch (error) {
						fail(error);
					}
				}}
			/>
			<ConfirmDialog
				open={pendingFieldDelete && field !== null}
				title={t("researchTable.deleteFieldTitle")}
				description={t("researchTable.deleteFieldBody", {
					name: field?.name.trim() || t("researchTable.field"),
				})}
				confirmLabel={t("researchTable.deleteField")}
				destructive
				onOpenChange={(open) => {
					if (!open) setPendingFieldDelete(false);
				}}
				onConfirm={() => {
					if (!field) return;
					try {
						change(removeField(table, field.id));
						setField(null);
						setPendingFieldDelete(false);
					} catch (error) {
						fail(error);
					}
				}}
			/>
		</section>
	);
}
