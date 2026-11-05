import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TableGrid } from "@/components/research-table/table-grid";
import {
	type TableSaveState,
	TableToolbar,
} from "@/components/research-table/table-toolbar";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
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
import {
	appendRows,
	fieldTypes,
	parseResearchTable,
	type ResearchTable,
	removeField,
	replaceField,
	type TableField,
} from "@/lib/research-table/model";
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
function read(source: string): ResearchTable | null {
	try {
		return parseResearchTable(source);
	} catch {
		return null;
	}
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
	const [table, setTable] = useState(() => read(seed));
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
			if (current.current)
				history.current = [...history.current.slice(-19), current.current];
			future.current = [];
			setSnapshot(next);
		},
		[setSnapshot],
	);
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
		const next = read(seed);
		current.current = next;
		setTable(next);
		saved.current = seed;
		savedRevision.current = next?.revision ?? 0;
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
	if (!table)
		return (
			<p className="p-4 text-muted-foreground" role="alert">
				{t("researchTable.invalidFile")}
			</p>
		);
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
					setField({
						id: crypto.randomUUID(),
						name: "",
						type: "text",
						unit: "",
						options: [],
					})
				}
				canRedo={!!future.current.length}
				onUndo={undo}
				onAddRows={(count) => {
					try {
						change(appendRows(table, count));
					} catch (error) {
						fail(error);
					}
				}}
			/>
			<div className="min-h-0 flex-1 overflow-hidden border-y border-border/60">
				<TableGrid
					table={table}
					onChange={change}
					onField={(index) => {
						if (table.fields[index]) setField({ ...table.fields[index] });
					}}
					onAddField={() =>
						setField({
							id: crypto.randomUUID(),
							name: "",
							type: "text",
							unit: "",
							options: [],
						})
					}
					height="100%"
				/>
			</div>
			<footer className="flex h-7 shrink-0 items-center px-4 text-[0.6875rem] tabular-nums text-muted-foreground">
				{t("researchTable.dimensions", {
					rows: table.rows.length,
					columns: table.fields.length,
				})}
			</footer>
			<Dialog
				open={field !== null}
				onOpenChange={(open) => {
					if (!open) setField(null);
				}}
			>
				<DialogContent>
					<DialogTitle>{t("researchTable.field")}</DialogTitle>
					{field && (
						<form
							className="grid gap-3"
							onSubmit={(event) => {
								event.preventDefault();
								try {
									change(replaceField(table, field));
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
								<label htmlFor={`${formId}-options`}>
									{t("researchTable.options")}
									<Input
										id={`${formId}-options`}
										value={field.options.join(",")}
										onChange={(e) =>
											setField({
												...field,
												options: e.target.value.split(",").map((x) => x.trim()),
											})
										}
									/>
								</label>
							)}
							<DialogFooter>
								{table.fields.some((f) => f.id === field.id) ? (
									<Button
										type="button"
										variant="destructive"
										disabled={table.fields.length === 1}
										onClick={() => {
											try {
												change(removeField(table, field.id));
												setField(null);
											} catch (error) {
												fail(error);
											}
										}}
									>
										{t("researchTable.deleteField")}
									</Button>
								) : null}
								<Button type="submit">{t("researchTable.save")}</Button>
							</DialogFooter>
						</form>
					)}
				</DialogContent>
			</Dialog>
		</section>
	);
}
