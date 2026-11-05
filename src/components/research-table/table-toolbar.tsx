import {
	Check,
	ChevronDown,
	Columns3,
	Copy,
	Download,
	Ellipsis,
	Plus,
	Redo2,
	Save,
	Table,
	Undo2,
} from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
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
import { notifyError } from "@/lib/core/notify";
import { researchTableErrorMessage } from "@/lib/research-table/errors";
import type { ResearchTable } from "@/lib/research-table/model";

export type TableSaveState = "saved" | "pending" | "saving" | "error";

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
}) {
	const { t } = useTranslation("editor");
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState(table.name);
	const [batchOpen, setBatchOpen] = useState(false);
	const [count, setCount] = useState(10);
	const { compositionProps, isBlockedByIme } = useImeGuard();
	const commitName = () => {
		const next = name.trim();
		if (next && next !== table.name) onChange({ ...table, name: next });
		setEditing(false);
	};
	const fail = (error: unknown) =>
		notifyError(researchTableErrorMessage(error));
	const copyReference = async () => {
		const root = (vaultPath ?? "").replaceAll("\\", "/").replace(/\/$/, "");
		const normalized = path.replaceAll("\\", "/");
		if (!normalized.startsWith(`${root}/`)) return;
		try {
			await navigator.clipboard.writeText(
				`::research-table{path=${JSON.stringify(normalized.slice(root.length + 1))}}`,
			);
		} catch (error) {
			fail(error);
		}
	};
	const exportCsv = async () => {
		try {
			const csvCell = (value: unknown) =>
				`"${String(value ?? "").replaceAll('"', '""')}"`;
			const csv = [
				table.fields
					.map((f) => csvCell(f.unit ? `${f.name} (${f.unit})` : f.name))
					.join(","),
				...table.rows.map((row) =>
					table.fields.map((f) => csvCell(row.values[f.id])).join(","),
				),
			].join("\r\n");
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
						className={`flex items-center gap-1.5 text-xs ${saveState === "error" ? "text-destructive" : "text-muted-foreground"}`}
					>
						{saveState === "saved" && <Check className="size-3" aria-hidden />}
						<span className="sr-only @sm:not-sr-only">
							{t(`researchTable.saveState.${saveState}`)}
						</span>
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
			<div className="flex items-center justify-between py-2">
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
							{[10, 100, 1000].map((amount) => (
								<Button
									key={amount}
									variant="secondary"
									size="sm"
									className="flex-1 tabular-nums"
									onClick={() => {
										onAddRows(amount);
										setBatchOpen(false);
									}}
								>
									+{amount}
								</Button>
							))}
						</div>
						<form
							className="flex items-center gap-2"
							onSubmit={(event) => {
								event.preventDefault();
								onAddRows(count);
								setBatchOpen(false);
							}}
						>
							<Input
								type="number"
								min={1}
								max={1000}
								required
								className="h-7 min-w-0 tabular-nums"
								aria-label={t("researchTable.rowCount")}
								value={count}
								onChange={(event) => setCount(Number(event.target.value))}
							/>
							<Button size="sm" type="submit">
								{t("researchTable.addRows")}
							</Button>
						</form>
					</PopoverContent>
				</Popover>
			</div>
		</header>
	);
}
