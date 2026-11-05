import {
	Columns3,
	Copy,
	Download,
	Plus,
	Redo2,
	Save,
	Undo2,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { TableGrid } from "@/components/research-table/table-grid";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { isImeKeyboardEvent } from "@/lib/core/ime";
import { notifyError } from "@/lib/core/notify";
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
	const [busy, setBusy] = useState(false);
	const [field, setField] = useState<TableField | null>(null);
	const [count, setCount] = useState(10);
	const setSnapshot = useCallback((next: ResearchTable) => {
		if (current.current === next) return;
		current.current = next;
		setTable(next);
		dirty.current = true;
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
		setBusy(true);
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
			return ok;
		} finally {
			if (saving.current === attempt) saving.current = null;
			setBusy(false);
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
		notifyError(
			t("researchTable.invalid", {
				detail: error instanceof Error ? error.message : String(error),
			}),
		);
	return (
		<section
			className="flex h-full min-h-0 flex-col gap-3 p-4"
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
			<div className="flex flex-wrap items-center gap-2">
				<Input
					className="max-w-64"
					aria-label={t("researchTable.name")}
					value={table.name}
					onChange={(e) => {
						if (e.target.value.trim())
							change({ ...table, name: e.target.value });
					}}
				/>
				<select
					className="h-8 rounded border bg-background px-2 text-sm"
					aria-label={t("researchTable.kind")}
					value={table.kind}
					onChange={(e) =>
						change({ ...table, kind: e.target.value as ResearchTable["kind"] })
					}
				>
					<option value="result">{t("researchTable.result")}</option>
					<option value="entity">{t("researchTable.entity")}</option>
				</select>
				<Button
					variant="ghost"
					size="icon"
					title={t("researchTable.undo")}
					aria-label={t("researchTable.undo")}
					disabled={!history.current.length}
					onClick={() => undo()}
				>
					<Undo2 />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					title={t("researchTable.redo")}
					aria-label={t("researchTable.redo")}
					disabled={!future.current.length}
					onClick={() => undo(true)}
				>
					<Redo2 />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					aria-label={t("researchTable.save")}
					title={t("researchTable.save")}
					disabled={busy}
					onClick={() => void flush()}
				>
					<Save />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					aria-label={t("researchTable.embed")}
					title={t("researchTable.embed")}
					disabled={!vaultPath}
					onClick={() => {
						const root = (vaultPath ?? "")
							.replaceAll("\\", "/")
							.replace(/\/$/, "");
						const normalized = path.replaceAll("\\", "/");
						if (!normalized.startsWith(`${root}/`)) return;
						void navigator.clipboard
							.writeText(
								`::research-table{path=${JSON.stringify(normalized.slice(root.length + 1))}}`,
							)
							.catch(fail);
					}}
				>
					<Copy />
				</Button>
				<Button
					variant="ghost"
					size="icon"
					title={t("researchTable.export")}
					aria-label={t("researchTable.export")}
					onClick={async () => {
						const csvCell = (v: unknown) =>
							`"${String(v ?? "").replaceAll('"', '""')}"`;
						const csv = [
							table.fields
								.map((f) => csvCell(f.unit ? `${f.name} (${f.unit})` : f.name))
								.join(","),
							...table.rows.map((r) =>
								table.fields.map((f) => csvCell(r.values[f.id])).join(","),
							),
						].join("\r\n");
						try {
							const { save } = await import("@tauri-apps/plugin-dialog");
							const { writeVaultFile } = await import("@/lib/vault/fs");
							const destination = await save({
								defaultPath: `${table.name.replace(/[\\/:*?"<>|]/g, "_")}.csv`,
								filters: [{ name: "CSV", extensions: ["csv"] }],
							});
							if (destination)
								await writeVaultFile(destination, `\ufeff${csv}`);
						} catch (error) {
							fail(error);
						}
					}}
				>
					<Download />
				</Button>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<Input
					type="number"
					min={1}
					max={1000}
					className="w-24"
					aria-label={t("researchTable.rowCount")}
					value={count}
					onChange={(e) => setCount(Number(e.target.value))}
				/>
				<Button
					variant="outline"
					onClick={() => {
						try {
							change(appendRows(table, count));
						} catch (error) {
							fail(error);
						}
					}}
				>
					<Plus />
					{t("researchTable.addRows")}
				</Button>
				<Button
					variant="outline"
					onClick={() =>
						setField({
							id: crypto.randomUUID(),
							name: "",
							type: "text",
							unit: "",
							options: [],
						})
					}
				>
					<Columns3 />
					{t("researchTable.addField")}
				</Button>
				<span className="text-xs text-muted-foreground">
					{t("researchTable.dimensions", {
						rows: table.rows.length,
						columns: table.fields.length,
					})}
				</span>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden rounded border">
				<TableGrid
					table={table}
					onChange={change}
					onField={(index) => {
						if (table.fields[index]) setField({ ...table.fields[index] });
					}}
					height="100%"
				/>
			</div>
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
							<label>
								{t("researchTable.type")}
								<select
									className="ml-2 h-8 rounded border bg-background px-2"
									value={field.type}
									onChange={(e) =>
										setField({
											...field,
											type: e.target.value as TableField["type"],
										})
									}
								>
									{fieldTypes.map((type) => (
										<option key={type} value={type}>
											{t(`researchTable.types.${type}`)}
										</option>
									))}
								</select>
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
