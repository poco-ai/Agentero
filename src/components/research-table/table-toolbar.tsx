import {
	Archive,
	ArchiveRestore,
	Check,
	ChevronDown,
	CircleAlert,
	Columns3,
	Copy,
	CopyPlus,
	Download,
	Ellipsis,
	FileJson,
	Info,
	Plus,
	Redo2,
	Save,
	Table,
	Trash2,
	Undo2,
	X,
} from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { ConfirmDialog } from "@/components/research-table/confirm-dialog";
import type { TableRowRef } from "@/components/research-table/table-grid";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuRadioGroup,
	DropdownMenuRadioItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useImeGuard } from "@/hooks/use-ime-guard";
import { formatLocaleTimestamp } from "@/i18n";
import { notifyError } from "@/lib/core/notify";
import {
	type ResearchTableBacklink,
	researchTableBacklinks,
} from "@/lib/research-table/catalog";
import { researchTableErrorMessage } from "@/lib/research-table/errors";
import { researchTableDirective } from "@/lib/research-table/markdown";
import {
	acceptsSchemaPath,
	applySchemaFields,
	checkSchema,
	parseResearchTable,
	type ResearchTable,
} from "@/lib/research-table/model";
import { researchTableCsv } from "@/lib/research-table/view";
import {
	joinVaultPath,
	readVaultFile,
	vaultPathExists,
	vaultRelativePath,
} from "@/lib/vault";
import { openPath } from "@/lib/workspace/navigation";

export type TableSaveState = "saved" | "pending" | "saving" | "error";

const BATCH_ROW_CAP = 500;
const BATCH_ROW_CONFIRM = 100;

export function TableToolbar({
	table,
	path,
	vaultPath,
	onChange,
	onAddRows,
	onAddField,
	onUndo,
	canUndo,
	canRedo,
	onSave,
	saveState,
	query,
	onQueryChange,
	visibleRows,
	showArchived,
	onShowArchived,
	canManageArchived,
	onRestoreArchived,
	onDeleteArchived,
	selectedRows,
	onDuplicateRows,
}: {
	table: ResearchTable;
	path: string;
	vaultPath: string | null;
	onChange: (table: ResearchTable) => void;
	onAddRows: (count: number) => void;
	onAddField: () => void;
	onUndo: (forward?: boolean) => void;
	canUndo: boolean;
	canRedo: boolean;
	onSave: () => void;
	saveState: TableSaveState;
	query: string;
	onQueryChange: (query: string) => void;
	visibleRows: number;
	showArchived: boolean;
	onShowArchived: (show: boolean) => void;
	canManageArchived: boolean;
	onRestoreArchived: () => void;
	onDeleteArchived: () => void;
	selectedRows: readonly TableRowRef[];
	onDuplicateRows: (indexes: readonly number[]) => void;
}) {
	const { t, i18n } = useTranslation("editor");
	const schemaId = useId();
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(table.name);
	const [batchOpen, setBatchOpen] = useState(false);
	const [count, setCount] = useState(10);
	const [pendingRows, setPendingRows] = useState<number | null>(null);
	const [pendingDuplicate, setPendingDuplicate] = useState<
		readonly number[] | null
	>(null);
	const [schemaOpen, setSchemaOpen] = useState(false);
	const [schemaDraft, setSchemaDraft] = useState(table.schemaPath ?? "");
	const [schemaBusy, setSchemaBusy] = useState(false);
	const [schemaNotice, setSchemaNotice] = useState<string | null>(null);
	const { compositionProps, isBlockedByIme } = useImeGuard();
	const relativePath = vaultPath ? vaultRelativePath(vaultPath, path) : null;
	const [backlinks, setBacklinks] = useState<ResearchTableBacklink[] | null>(
		null,
	);
	useEffect(() => {
		if (!vaultPath || !relativePath) {
			setBacklinks(null);
			return;
		}
		let cancelled = false;
		void researchTableBacklinks({
			vaultPath,
			path: relativePath,
			id: table.id,
		})
			.then((notes) => {
				if (!cancelled) setBacklinks(notes);
			})
			.catch(() => {
				if (!cancelled) setBacklinks(null);
			});
		return () => {
			cancelled = true;
		};
	}, [relativePath, table.id, vaultPath]);
	useEffect(() => {
		const schemaPath = table.schemaPath;
		if (!schemaPath || !vaultPath) {
			setSchemaNotice(null);
			return;
		}
		let cancelled = false;
		void vaultPathExists(joinVaultPath(vaultPath, schemaPath))
			.then((exists) => {
				if (!cancelled)
					setSchemaNotice(exists ? null : t("researchTable.schemaMissing"));
			})
			.catch(() => {
				if (!cancelled) setSchemaNotice(null);
			});
		return () => {
			cancelled = true;
		};
	}, [table.schemaPath, vaultPath, t]);
	const readSchema = async (candidate: string) => {
		const trimmed = candidate.trim();
		const own = vaultPath ? vaultRelativePath(vaultPath, path) : null;
		if (!vaultPath || !acceptsSchemaPath(trimmed, own ?? undefined)) {
			notifyError(t("researchTable.errors.path"));
			return null;
		}
		const absolute = joinVaultPath(vaultPath, trimmed);
		if (!(await vaultPathExists(absolute)))
			return { missing: true as const, path: trimmed };
		try {
			return {
				missing: false as const,
				path: trimmed,
				schema: parseResearchTable(await readVaultFile(absolute)),
			};
		} catch (error) {
			notifyError(researchTableErrorMessage(error));
			return null;
		}
	};
	const confirmSchema = async () => {
		const trimmed = schemaDraft.trim();
		if (!trimmed) {
			if (table.schemaPath !== undefined) {
				const next = { ...table };
				delete next.schemaPath;
				onChange(next);
			}
			setSchemaNotice(null);
			setSchemaOpen(false);
			return;
		}
		setSchemaBusy(true);
		try {
			const loaded = await readSchema(trimmed);
			if (!loaded) return;
			if (loaded.missing) {
				onChange({ ...table, schemaPath: loaded.path });
				setSchemaNotice(t("researchTable.schemaMissing"));
				setSchemaOpen(false);
				return;
			}
			if (!checkSchema(table, loaded.schema).ok) {
				notifyError(t("researchTable.errors.schemaMismatch"));
				return;
			}
			onChange({ ...table, schemaPath: loaded.path });
			setSchemaNotice(null);
			setSchemaOpen(false);
		} finally {
			setSchemaBusy(false);
		}
	};
	const applySchema = async () => {
		setSchemaBusy(true);
		try {
			const loaded = await readSchema(schemaDraft);
			if (!loaded) return;
			if (loaded.missing) {
				notifyError(t("researchTable.schemaMissing"));
				return;
			}
			try {
				const next = applySchemaFields(table, loaded.schema);
				if (next !== table) onChange(next);
				setSchemaOpen(false);
			} catch (error) {
				notifyError(researchTableErrorMessage(error));
			}
		} finally {
			setSchemaBusy(false);
		}
	};
	const commitName = () => {
		const next = name.trim();
		if (next && next !== table.name) onChange({ ...table, name: next });
		setEditing(false);
	};
	const fail = (error: unknown) =>
		notifyError(researchTableErrorMessage(error));
	const requestRows = (amount: number) => {
		const next = Math.trunc(amount);
		if (!Number.isInteger(next) || next < 1) return;
		const capped = Math.min(next, BATCH_ROW_CAP);
		setBatchOpen(false);
		if (capped >= BATCH_ROW_CONFIRM) {
			setPendingRows(capped);
			return;
		}
		onAddRows(capped);
	};
	const copyReference = async () => {
		const root = (vaultPath ?? "").replaceAll("\\", "/").replace(/\/$/, "");
		const normalized = path.replaceAll("\\", "/");
		if (!root || !normalized.startsWith(`${root}/`)) {
			notifyError(t("researchTable.outsideVault"));
			return;
		}
		try {
			await navigator.clipboard.writeText(
				researchTableDirective(normalized.slice(root.length + 1), table.id),
			);
		} catch (error) {
			fail(error);
		}
	};
	const requestDuplicate = () => {
		const indexes = selectedRows.map((row) => row.index);
		if (!indexes.length) return;
		if (indexes.length >= BATCH_ROW_CONFIRM) {
			setPendingDuplicate(indexes);
			return;
		}
		onDuplicateRows(indexes);
	};
	const exportCsv = async () => {
		try {
			const csv = researchTableCsv(table);
			const { save } = await import("@tauri-apps/plugin-dialog");
			const { writeVaultFile } = await import("@/lib/vault/fs");
			const destination = await save({
				defaultPath: `${table.name.replace(/[\\/:*?"<>|]/g, "_")}.csv`,
				filters: [{ name: "CSV", extensions: ["csv"] }],
			});
			if (destination) await writeVaultFile(destination, `\ufeff${csv}`);
		} catch (error) {
			fail(error);
		}
	};
	return (
		<header className="shrink-0 px-4 pt-3">
			<div className="flex min-w-0 items-center gap-2">
				<Table className="size-4 shrink-0 text-muted-foreground" aria-hidden />
				{editing ? (
					<Input
						autoFocus
						className="h-8 min-w-0 max-w-80 text-base font-semibold"
						aria-label={t("researchTable.name")}
						value={name}
						{...compositionProps}
						onFocus={(event) => event.currentTarget.select()}
						onChange={(event) => setName(event.target.value)}
						onBlur={commitName}
						onKeyDown={(event) => {
							event.stopPropagation();
							if (isBlockedByIme(event)) return;
							if (event.key === "Enter") {
								event.preventDefault();
								commitName();
							}
							if (event.key === "Escape") {
								event.preventDefault();
								setEditing(false);
							}
						}}
					/>
				) : (
					<h1 className="min-w-0">
						<button
							type="button"
							className="block max-w-full truncate rounded px-1 py-1 text-base font-semibold tracking-tight outline-none hover:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring"
							title={table.name}
							onClick={() => {
								setName(table.name);
								setEditing(true);
							}}
						>
							{table.name}
						</button>
					</h1>
				)}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							variant="ghost"
							size="sm"
							className="h-6 shrink-0 gap-1 rounded-md bg-muted/60 px-2 font-normal text-muted-foreground"
							aria-label={t("researchTable.kind")}
						>
							{t(`researchTable.${table.kind}`)}
							<ChevronDown className="size-3" />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent>
						<DropdownMenuRadioGroup
							value={table.kind}
							onValueChange={(kind) =>
								onChange({ ...table, kind: kind as ResearchTable["kind"] })
							}
						>
							<DropdownMenuRadioItem value="result">
								{t("researchTable.result")}
							</DropdownMenuRadioItem>
							<DropdownMenuRadioItem value="entity">
								{t("researchTable.entity")}
							</DropdownMenuRadioItem>
						</DropdownMenuRadioGroup>
					</DropdownMenuContent>
				</DropdownMenu>
				<div className="ml-auto flex shrink-0 items-center gap-1">
					<span
						role="status"
						className={`flex shrink-0 items-center gap-1.5 text-xs whitespace-nowrap ${saveState === "error" ? "text-destructive" : "text-muted-foreground"}`}
					>
						{saveState === "saved" && <Check className="size-3" aria-hidden />}
						{saveState === "error" && (
							<CircleAlert className="size-3" aria-hidden />
						)}
						{t(`researchTable.saveState.${saveState}`)}
					</span>
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								aria-label={t("researchTable.more")}
							>
								<Ellipsis />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="min-w-48">
							<DropdownMenuItem
								disabled={table.fields.length >= 100}
								onSelect={onAddField}
							>
								<Columns3 />
								{t("researchTable.addField")}
							</DropdownMenuItem>
							<DropdownMenuItem
								disabled={saveState === "saving"}
								onSelect={onSave}
							>
								<Save />
								{t("researchTable.save")}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								onSelect={() => {
									setSchemaDraft(table.schemaPath ?? "");
									setSchemaOpen(true);
								}}
							>
								<FileJson />
								{t("researchTable.schema")}
							</DropdownMenuItem>
							<DropdownMenuItem
								disabled={!vaultPath}
								onSelect={() => void copyReference()}
							>
								<Copy />
								{t("researchTable.embed")}
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => void exportCsv()}>
								<Download />
								{t("researchTable.export")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			{backlinks ? (
				<div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 pb-1 text-xs text-muted-foreground">
					<span>
						{t("researchTable.backlinks", { count: backlinks.length })}
					</span>
					{backlinks.slice(0, 6).map((note) => (
						<button
							key={note.path}
							type="button"
							className="max-w-48 truncate rounded-sm px-1 hover:bg-accent hover:text-foreground"
							onClick={() => {
								if (!vaultPath) return;
								openPath(joinVaultPath(vaultPath, note.path));
							}}
						>
							{note.path}
						</button>
					))}
				</div>
			) : null}
			<div className="flex flex-wrap items-center gap-2 py-2">
				<div className="flex items-center gap-0.5">
					{(
						[
							{
								forward: false,
								enabled: canUndo,
								Icon: Undo2,
								label: t("researchTable.undo"),
							},
							{
								forward: true,
								enabled: canRedo,
								Icon: Redo2,
								label: t("researchTable.redo"),
							},
						] as const
					).map(({ forward, enabled, Icon, label }) => (
						<Tooltip key={String(forward)}>
							<TooltipTrigger asChild>
								<span className="inline-flex">
									<Button
										variant="ghost"
										size="icon-sm"
										disabled={!enabled}
										aria-label={label}
										onClick={() => onUndo(forward)}
									>
										<Icon className="size-3.5" />
									</Button>
								</span>
							</TooltipTrigger>
							<TooltipContent>
								{label}
								<span className="opacity-60">
									{forward ? "⌘/Ctrl ⇧ Z" : "⌘/Ctrl Z"}
								</span>
							</TooltipContent>
						</Tooltip>
					))}
				</div>
				<div className="flex min-w-32 flex-1 items-center gap-1">
					<Input
						className="h-8 min-w-0"
						aria-label={t("researchTable.filter")}
						placeholder={t("researchTable.filter")}
						value={query}
						onChange={(event) => onQueryChange(event.target.value)}
					/>
					{query ? (
						<Button
							variant="ghost"
							size="icon-sm"
							aria-label={t("researchTable.clearFilter")}
							onClick={() => onQueryChange("")}
						>
							<X />
						</Button>
					) : null}
					{query.trim() ? (
						<span className="shrink-0 text-xs text-muted-foreground tabular-nums">
							{t("researchTable.filterMatches", { count: visibleRows })}
						</span>
					) : null}
				</div>
				{selectedRows.length > 0 ? (
					<>
						<RowDetails
							table={table}
							rows={selectedRows}
							locale={i18n.language}
						/>
						<Button variant="ghost" size="sm" onClick={requestDuplicate}>
							<CopyPlus />
							{t("researchTable.duplicateRows")}
						</Button>
					</>
				) : null}
				<Button
					variant={showArchived ? "secondary" : "ghost"}
					size="sm"
					aria-pressed={showArchived}
					onClick={() => onShowArchived(!showArchived)}
				>
					<Archive />
					{t("researchTable.showArchived")}
				</Button>
				{canManageArchived ? (
					<>
						<Button variant="ghost" size="sm" onClick={onRestoreArchived}>
							<ArchiveRestore />
							{t("researchTable.restoreRows")}
						</Button>
						<Button variant="ghost" size="sm" onClick={onDeleteArchived}>
							<Trash2 />
							{t("researchTable.deletePermanently")}
						</Button>
					</>
				) : null}
				{schemaNotice ? (
					<span role="status" className="text-xs text-muted-foreground">
						{schemaNotice}
					</span>
				) : null}
				<Popover open={batchOpen} onOpenChange={setBatchOpen}>
					<div className="flex items-center rounded-lg bg-secondary text-secondary-foreground">
						<Button
							variant="ghost"
							size="sm"
							className="rounded-r-none"
							onClick={() => onAddRows(1)}
						>
							<Plus />
							{t("researchTable.addRows")}
						</Button>
						<PopoverTrigger asChild>
							<Button
								variant="ghost"
								size="icon-sm"
								className="rounded-l-none border-l border-foreground/10"
								aria-label={t("researchTable.batchRows")}
							>
								<ChevronDown className="size-3" />
							</Button>
						</PopoverTrigger>
					</div>
					<PopoverContent align="end" className="w-56 gap-3 p-3">
						<div className="flex gap-1">
							{[10, 100].map((amount) => (
								<Button
									key={amount}
									variant="secondary"
									size="sm"
									className="flex-1 tabular-nums"
									onClick={() => requestRows(amount)}
								>
									+{amount}
								</Button>
							))}
						</div>
						<form
							className="flex items-center gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								requestRows(count);
							}}
						>
							<Input
								type="number"
								min={1}
								max={BATCH_ROW_CAP}
								required
								className="h-7 min-w-0 tabular-nums"
								aria-label={t("researchTable.rowCount")}
								value={count}
								onChange={(event) => {
									const next = Math.trunc(Number(event.target.value));
									if (!Number.isFinite(next)) return;
									setCount(Math.min(BATCH_ROW_CAP, Math.max(1, next)));
								}}
							/>
							<Button size="sm" type="submit">
								{t("researchTable.addRows")}
							</Button>
						</form>
					</PopoverContent>
				</Popover>
			</div>
			<Dialog open={schemaOpen} onOpenChange={setSchemaOpen}>
				<DialogContent className="sm:max-w-md">
					<DialogHeader>
						<DialogTitle>{t("researchTable.schema")}</DialogTitle>
					</DialogHeader>
					<form
						className="grid gap-3"
						onSubmit={(event) => {
							event.preventDefault();
							void confirmSchema();
						}}
					>
						<label htmlFor={schemaId}>
							{t("researchTable.schemaPath")}
							<Input
								id={schemaId}
								value={schemaDraft}
								placeholder="data/schema.table.json"
								disabled={schemaBusy}
								{...compositionProps}
								onChange={(event) => setSchemaDraft(event.target.value)}
								onKeyDown={(event) => {
									if (isBlockedByIme(event) && event.key === "Enter")
										event.preventDefault();
								}}
							/>
						</label>
						<DialogFooter>
							<Button
								type="button"
								variant="outline"
								disabled={schemaBusy}
								onClick={() => void applySchema()}
							>
								{t("researchTable.applySchema")}
							</Button>
							<Button type="submit" disabled={schemaBusy}>
								{t("researchTable.useSchema")}
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
			<ConfirmDialog
				open={pendingDuplicate !== null}
				title={t("researchTable.duplicateRowsTitle")}
				description={t("researchTable.duplicateRowsBody", {
					count: pendingDuplicate?.length ?? 0,
				})}
				confirmLabel={t("researchTable.duplicateRows")}
				onOpenChange={(open) => {
					if (!open) setPendingDuplicate(null);
				}}
				onConfirm={() => {
					if (pendingDuplicate) onDuplicateRows(pendingDuplicate);
					setPendingDuplicate(null);
				}}
			/>
			<ConfirmDialog
				open={pendingRows !== null}
				title={t("researchTable.addBlankRowsTitle")}
				description={t("researchTable.addBlankRowsBody", {
					count: pendingRows ?? 0,
				})}
				confirmLabel={t("researchTable.addRows")}
				onOpenChange={(open) => {
					if (!open) setPendingRows(null);
				}}
				onConfirm={() => {
					if (pendingRows) onAddRows(pendingRows);
					setPendingRows(null);
				}}
			/>
		</header>
	);
}

function RowDetails({
	table,
	rows,
	locale,
}: {
	table: ResearchTable;
	rows: readonly TableRowRef[];
	locale: string;
}) {
	const { t } = useTranslation("editor");
	const entries = rows.flatMap((ref) => {
		const row = table.rows[ref.index];
		if (!row || row.id !== ref.id) return [];
		const lines: { label: string; value: string }[] = [];
		if (row.registryId)
			lines.push({
				label: t("researchTable.registryId"),
				value: row.registryId,
			});
		if (row.createdAt)
			lines.push({
				label: t("researchTable.created"),
				value: formatLocaleTimestamp(row.createdAt, locale),
			});
		if (row.updatedAt)
			lines.push({
				label: t("researchTable.updated"),
				value: formatLocaleTimestamp(row.updatedAt, locale),
			});
		if (row.actor === "human" || row.actor === "agent")
			lines.push({
				label: t("researchTable.lastEditor"),
				value: t(
					row.actor === "agent"
						? "researchTable.actorAgent"
						: "researchTable.actorHuman",
				),
			});
		if (!lines.length) return [];
		return [{ id: row.id, lines }];
	});
	if (!entries.length) return null;
	return (
		<Popover>
			<PopoverTrigger asChild>
				<Button
					variant="ghost"
					size="sm"
					aria-label={t("researchTable.details")}
				>
					<Info />
					{t("researchTable.details")}
				</Button>
			</PopoverTrigger>
			<PopoverContent align="end" className="max-h-80 overflow-auto">
				<div className="grid gap-3">
					{entries.map((entry) => (
						<dl
							key={entry.id}
							className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs"
						>
							{entry.lines.map((line) => (
								<div key={line.label} className="contents">
									<dt className="text-muted-foreground">{line.label}</dt>
									<dd className="min-w-0 truncate">{line.value}</dd>
								</div>
							))}
						</dl>
					))}
				</div>
			</PopoverContent>
		</Popover>
	);
}
