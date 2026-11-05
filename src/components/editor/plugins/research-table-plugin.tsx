import { Ellipsis, ExternalLink, RefreshCw, Table } from "lucide-react";
import {
	createPlatePlugin,
	PlateElement,
	type PlateElementProps,
	useEditorRef,
	useReadOnly,
} from "platejs/react";
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
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
	RESEARCH_TABLE_KEY,
	safeTableReference,
} from "@/lib/research-table/markdown";
import {
	parseResearchTable,
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
	const [draft, setDraft] = useState(target);
	const [table, setTable] = useState<ResearchTable | null>(null);
	const [failed, setFailed] = useState(false);
	const [refresh, setRefresh] = useState(0);
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
	const commit = useCallback(() => {
		if (!safeTableReference(draft)) {
			notifyError(t("researchTable.invalidFile"));
			return;
		}
		const at = editor.api.findPath(props.element);
		if (at) editor.tf.setNodes({ tablePath: draft }, { at });
	}, [draft, editor, props.element, t]);
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
				{!target && !readonly ? (
					<div className="flex gap-2 p-3">
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
				{table ? (
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
								{table.rows.slice(0, 20).map((row) => (
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
								table={{ ...table, rows: table.rows.slice(0, 20) }}
								height={Math.min(
									360,
									Math.max(110, table.rows.length * 34 + 40),
								)}
							/>
						</Suspense>
					)
				) : target ? (
					<p className="px-3 py-2 text-sm text-muted-foreground">
						{t(
							failed || !absolute
								? "researchTable.invalidFile"
								: "researchTable.loading",
						)}
					</p>
				) : null}
				{table ? (
					<p className="border-t border-border/60 px-3 py-1.5 text-[0.6875rem] tabular-nums text-muted-foreground">
						{t("researchTable.preview", {
							shown: Math.min(20, table.rows.length),
							total: table.rows.length,
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
