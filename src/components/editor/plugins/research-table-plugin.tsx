import { ExternalLink, RefreshCw } from "lucide-react";
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
				className="my-3 min-w-0 rounded border bg-background p-2"
				onKeyDown={(event) => event.stopPropagation()}
				onCopy={(event) => event.stopPropagation()}
				onCut={(event) => event.stopPropagation()}
				onPaste={(event) => event.stopPropagation()}
			>
				{!target && !readonly ? (
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
				{target ? (
					<div className="mb-2 flex items-center justify-between gap-2 text-sm">
						<span className="truncate">{table?.name ?? target}</span>
						{!exportMode && (
							<div className="flex shrink-0 gap-1">
								<Button
									variant="ghost"
									size="icon"
									aria-label={t("researchTable.load")}
									onClick={() => setRefresh((n) => n + 1)}
								>
									<RefreshCw />
								</Button>
								<Button
									variant="ghost"
									size="icon"
									aria-label={t("researchTable.open")}
									onClick={() =>
										nav?.onWikiNavigate({
											path: target,
											targetRaw: target,
											status: "resolved",
										})
									}
								>
									<ExternalLink />
								</Button>
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
					<p className="text-sm text-muted-foreground">
						{t(
							failed || !absolute
								? "researchTable.invalidFile"
								: "researchTable.loading",
						)}
					</p>
				) : null}
				{table ? (
					<p className="mt-1 text-xs text-muted-foreground">
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
