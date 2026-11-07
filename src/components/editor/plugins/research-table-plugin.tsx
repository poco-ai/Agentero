import { Ellipsis, ExternalLink, RefreshCw, Table } from "lucide-react";
import {
	createPlatePlugin,
	PlateElement,
	type PlateElementProps,
	useEditorRef,
	useReadOnly,
} from "platejs/react";
import {
	lazy,
	Suspense,
	useCallback,
	useEffect,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { useMarkdownExportMode } from "@/components/editor/markdown-export-mode-context";
import { Button } from "@/components/ui/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { notifyError } from "@/lib/core/notify";
import {
	listResearchTables,
	type ResearchTableSummary,
} from "@/lib/research-table/catalog";
import {
	RESEARCH_TABLE_KEY,
	safeTableReference,
} from "@/lib/research-table/markdown";
import {
	parseResearchTable,
	previewRows,
	type ResearchTable,
} from "@/lib/research-table/model";
import { joinVaultPath, readVaultFile } from "@/lib/vault";
import { subscribeWikiEmbedTarget } from "@/lib/wiki/embed-refresh";
import { useWikiNav } from "@/lib/wiki/nav-context";

const Grid = lazy(() =>
	import("@/components/research-table/table-grid").then((m) => ({
		default: m.TableGrid,
	})),
);

function ResearchTableElement(props: PlateElementProps) {
	const { t } = useTranslation("editor");
	const nav = useWikiNav();
	const editor = useEditorRef();
	const readonly = useReadOnly();
	const exportMode = useMarkdownExportMode();
	const target = String(props.element.tablePath ?? "");
	const tableId = String(props.element.tableId ?? "");
	const [draft, setDraft] = useState(target);
	const [table, setTable] = useState<ResearchTable | null>(null);
	const [failed, setFailed] = useState(false);
	const [refresh, setRefresh] = useState(0);
	const [tables, setTables] = useState<ResearchTableSummary[] | null>(null);
	const [listTruncated, setListTruncated] = useState(false);
	const [listFailed, setListFailed] = useState(false);
	const recoverKey = `${tableId}\0${target}`;
	const [ambiguous, setAmbiguous] = useState<{
		key: string;
		paths: string[];
	} | null>(null);
	const attempted = useRef(new Set<string>());
	const recovering = useRef<string | null>(null);
	const editorRef = useRef(editor);
	editorRef.current = editor;
	const elementRef = useRef(props.element);
	elementRef.current = props.element;
	const absolute =
		nav?.vaultPath && safeTableReference(target)
			? joinVaultPath(nav.vaultPath, target)
			: null;
	useEffect(() => setDraft(target), [target]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: refresh deliberately re-reads the same target.
	useEffect(() => {
		let cancelled = false;
		setTable(null);
		setFailed(false);
		if (absolute)
			void readVaultFile(absolute)
				.then((source) => parseResearchTable(source))
				.then((value) => {
					if (!cancelled) setTable(value);
				})
				.catch(() => {
					if (!cancelled) setFailed(true);
				});
		return () => {
			cancelled = true;
		};
	}, [absolute, refresh]);
	useEffect(
		() =>
			absolute
				? subscribeWikiEmbedTarget(absolute, () => setRefresh((n) => n + 1))
				: undefined,
		[absolute],
	);
	const mismatched = Boolean(table && tableId && table.id !== tableId);
	const ambiguousPaths =
		(absolute === null || failed || mismatched) && ambiguous?.key === recoverKey
			? ambiguous.paths
			: [];
	useEffect(() => {
		if (!tableId || !nav?.vaultPath) return;
		const waiting = absolute !== null && table === null && !failed;
		if (waiting) return;
		const broken = absolute === null || failed || mismatched;
		if (!broken) return;
		if (attempted.current.has(recoverKey) || recovering.current === recoverKey)
			return;
		recovering.current = recoverKey;
		let cancelled = false;
		void listResearchTables(nav.vaultPath)
			.then((result) => {
				if (cancelled) return;
				const matches = result.tables.filter((item) => item.id === tableId);
				if (matches.length === 1) {
					const path = matches[0]?.path ?? "";
					if (!path || path === target || !safeTableReference(path)) {
						attempted.current.add(recoverKey);
						return;
					}
					// A locked or export render cannot rewrite the directive.
					// Leave this pair unmarked so an editable pass can.
					if (readonly || exportMode) return;
					attempted.current.add(recoverKey);
					const at = editorRef.current.api.findPath(elementRef.current);
					if (at)
						editorRef.current.tf.setNodes({ tablePath: path, tableId }, { at });
					return;
				}
				attempted.current.add(recoverKey);
				if (matches.length > 1)
					setAmbiguous({
						key: recoverKey,
						paths: matches.map((item) => item.path),
					});
			})
			.catch(() => {
				if (!cancelled) attempted.current.add(recoverKey);
			})
			.finally(() => {
				if (recovering.current === recoverKey) recovering.current = null;
			});
		return () => {
			cancelled = true;
			if (recovering.current === recoverKey) recovering.current = null;
		};
	}, [
		absolute,
		exportMode,
		failed,
		mismatched,
		nav?.vaultPath,
		readonly,
		recoverKey,
		table,
		tableId,
		target,
	]);
	const activeRows =
		table && !mismatched
			? table.rows.filter((row) => row.archivedAt === undefined)
			: [];
	const shownRows = previewRows(activeRows);
	useEffect(() => {
		if (target || readonly || !nav?.vaultPath) return;
		let cancelled = false;
		void listResearchTables(nav.vaultPath)
			.then((result) => {
				if (cancelled) return;
				setTables(result.tables);
				setListTruncated(result.truncated);
				setListFailed(false);
			})
			.catch(() => {
				if (cancelled) return;
				setTables([]);
				setListFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [nav?.vaultPath, readonly, target]);
	const commitPath = useCallback(
		(path: string, id = "") => {
			if (!safeTableReference(path)) {
				notifyError(t("researchTable.invalidFile"));
				return;
			}
			const at = editor.api.findPath(props.element);
			if (at) editor.tf.setNodes({ tablePath: path, tableId: id }, { at });
		},
		[editor, props.element, t],
	);
	const commit = useCallback(() => {
		commitPath(draft);
	}, [commitPath, draft]);
	const showPathInput =
		listFailed || listTruncated || (tables !== null && tables.length === 0);
	return (
		<PlateElement {...props}>
			<fieldset
				contentEditable={false}
				data-export-pending={absolute && !table && !failed ? "" : undefined}
				className="my-3 min-w-0 overflow-hidden rounded-lg border border-border/60 bg-background"
				onKeyDown={(event) => event.stopPropagation()}
				onCopy={(event) => event.stopPropagation()}
				onCut={(event) => event.stopPropagation()}
				onPaste={(event) => event.stopPropagation()}
			>
				{!target && !readonly && ambiguousPaths.length === 0 ? (
					<div className="flex flex-col gap-2 p-3">
						{tables && tables.length > 0 ? (
							<fieldset
								className="m-0 max-h-40 min-w-0 overflow-auto rounded-md border border-border/60 p-0"
								aria-label={t("researchTable.pickTable")}
							>
								{tables.map((item) => (
									<button
										key={item.path}
										type="button"
										className="flex w-full min-w-0 items-baseline gap-2 px-2 py-1.5 text-left text-sm hover:bg-accent"
										onClick={() => commitPath(item.path, item.id)}
									>
										<span className="truncate font-medium">{item.name}</span>
										<span className="min-w-0 flex-1 truncate text-muted-foreground">
											{item.path}
										</span>
										<span className="shrink-0 text-xs text-muted-foreground">
											{item.idPrefix || item.id}
										</span>
									</button>
								))}
							</fieldset>
						) : null}
						{showPathInput ? (
							<div className="flex gap-2">
								<Input
									aria-label={t("researchTable.path")}
									placeholder="data/results.table.json"
									value={draft}
									onChange={(e) => setDraft(e.target.value)}
								/>
								<Button variant="outline" onClick={commit}>
									{t("researchTable.load")}
								</Button>
							</div>
						) : null}
					</div>
				) : null}
				{target ? (
					<div className="flex min-h-10 items-center justify-between gap-2 px-3 text-sm">
						<div className="flex min-w-0 items-center gap-2">
							<Table
								className="size-3.5 shrink-0 text-muted-foreground"
								aria-hidden
							/>
							<span className="truncate font-medium">
								{table?.name ?? target}
							</span>
						</div>
						{!exportMode && (
							<div className="flex shrink-0 gap-1">
								<Button
									variant="ghost"
									size="sm"
									aria-label={t("researchTable.open")}
									onClick={() =>
										nav?.onWikiNavigate({
											path: target,
											targetRaw: target,
											status: "resolved",
										})
									}
								>
									{t("researchTable.open")}
									<ExternalLink className="size-3" />
								</Button>
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
									<DropdownMenuContent align="end">
										<DropdownMenuItem onSelect={() => setRefresh((n) => n + 1)}>
											<RefreshCw />
											{t("researchTable.refresh")}
										</DropdownMenuItem>
									</DropdownMenuContent>
								</DropdownMenu>
							</div>
						)}
					</div>
				) : null}
				{mismatched || ambiguousPaths.length > 0 ? (
					<div className="px-3 py-2 text-sm text-muted-foreground">
						<p>{t("researchTable.mismatch")}</p>
						{ambiguousPaths.length > 0 ? (
							<ul className="mt-1 grid gap-0.5">
								{ambiguousPaths.map((path) => (
									<li key={path} className="truncate" title={path}>
										{path}
									</li>
								))}
							</ul>
						) : null}
					</div>
				) : null}
				{table && !mismatched ? (
					exportMode ? (
						<table>
							<thead>
								<tr>
									{table.fields.map((f) => (
										<th key={f.id}>
											{f.name}
											{f.unit ? ` (${f.unit})` : ""}
										</th>
									))}
								</tr>
							</thead>
							<tbody>
								{shownRows.map((row) => (
									<tr key={row.id}>
										{table.fields.map((f) => (
											<td key={f.id}>{String(row.values[f.id] ?? "")}</td>
										))}
									</tr>
								))}
							</tbody>
						</table>
					) : (
						<Suspense fallback={<p>{t("researchTable.loading")}</p>}>
							<Grid
								table={{ ...table, rows: shownRows }}
								height={Math.min(
									360,
									Math.max(110, shownRows.length * 34 + 40),
								)}
							/>
						</Suspense>
					)
				) : target && !mismatched && ambiguousPaths.length === 0 ? (
					<p className="px-3 py-2 text-sm text-muted-foreground">
						{t(
							failed || !absolute
								? "researchTable.invalidFile"
								: "researchTable.loading",
						)}
					</p>
				) : null}
				{table && !mismatched ? (
					<p className="border-t border-border/60 px-3 py-1.5 text-[0.6875rem] tabular-nums text-muted-foreground">
						{t("researchTable.preview", {
							shown: shownRows.length,
							total: activeRows.length,
						})}
					</p>
				) : null}
			</fieldset>
			{props.children}
		</PlateElement>
	);
}
export const ResearchTablePlugin = createPlatePlugin({
	key: RESEARCH_TABLE_KEY,
	node: { isElement: true, isVoid: true },
}).withComponent(ResearchTableElement);
