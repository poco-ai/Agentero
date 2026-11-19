/**
 * Problems from the editor and from the last compile, in one place.
 * One alert entry opens the findings card; the card footer opens the full
 * build log (same findings, raw text on the right). The entry turns red while
 * there are errors, which is how a failed compile is reported here.
 */

import {
	FileText,
	MessageSquarePlus,
	Square,
	TriangleAlert,
} from "lucide-react";
import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
	FILE_TREE_ROW_SELECTED_STATE,
	FILE_TREE_ROW_STATE,
} from "@/components/sidebar/tree-row-styles";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	type EditorDiagnostic,
	SEVERITY_META,
} from "@/components/viewer/text-editor-lint-footer";
import { presentAgentComposer } from "@/lib/agent/composer-focus";
import {
	createSelectionContext,
	pinSelection,
} from "@/lib/agent/selection-store";
import { basenameOf, normalizePath } from "@/lib/core/path";
import { cancelTask } from "@/lib/core/tasks";
import { cn } from "@/lib/core/utils";
import { type TexBuildSnapshot, texBuildStore } from "@/lib/tex/build-state";
import { sortBySeverity } from "@/lib/tex/editor-diagnostic";
import {
	editorLintStore,
	pendingEditorLineJump,
} from "@/lib/tex/editor-lint-bridge";
import { navigateTexSource } from "@/lib/tex/editor-navigation";
import {
	compileFailureHeadline,
	type LogProblem,
	parseLatexLog,
	resolveLogProblemPath,
} from "@/lib/tex/log-problems";
import {
	readTexBuffers,
	subscribeTexBuffers,
	texBufferVersion,
} from "@/lib/tex/project-index";
import { type TexRequirement, texRequirements } from "@/lib/tex/requirements";
import { manuscriptDir } from "@/lib/writing/session";

type Row = {
	key: string;
	severity: "error" | "warning" | "info";
	message: string;
	where: string;
	logLine: number | null;
	sourcePath: string;
	line?: number;
	/** From the build log: pin the Agent reference as a build-log quote. */
	buildLog?: { detail?: string };
	jump: () => void;
};

export function WritingProblems({ rootFile }: { rootFile: string }) {
	const { t } = useTranslation(["latexBuild", "viewer", "sidebar"]);
	const key = normalizePath(rootFile);
	const snapshot = useStore(texBuildStore, (state) => state.byRoot[key]);
	const lint = useStore(editorLintStore, (state) => state.current);
	const [open, setOpen] = useState(false);
	const [listOpen, setListOpen] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const logRef = useRef<HTMLTextAreaElement>(null);
	const logText = snapshot?.logs.join("\n") ?? "";
	const bufferVersion = useSyncExternalStore(
		subscribeTexBuffers,
		texBufferVersion,
	);
	const compileProblems = useMemo(() => parseLatexLog(logText), [logText]);
	// bufferVersion is the open-buffer generation; readTexBuffers() is not a stable snapshot.
	// biome-ignore lint/correctness/useExhaustiveDependencies: bufferVersion is the re-scan signal
	const requirementRows = useMemo(() => {
		const dir = normalizePath(manuscriptDir(rootFile));
		const root = normalizePath(rootFile);
		const rows: Row[] = [];
		for (const [path, source] of readTexBuffers()) {
			const file = normalizePath(path);
			if (file !== root && !file.startsWith(`${dir}/`)) continue;
			for (const requirement of texRequirements(source))
				rows.push(
					requirementRow(
						path,
						requirement,
						requirementMessage(t, requirement.id),
					),
				);
		}
		return rows;
	}, [bufferVersion, rootFile, t]);
	const rows = useMemo(() => {
		const collected: Row[] = [
			...(lint && normalizePath(lint.path) === key
				? lint.diagnostics.map((diagnostic) =>
						editorRow(diagnostic, lint.path, lint.jump),
					)
				: []),
			...requirementRows,
			...compileProblems.map((problem) => compileRow(problem, rootFile)),
			...(snapshot?.status === "failed" &&
			!compileProblems.some((problem) => problem.severity === "error")
				? [
						buildFailureRow(
							snapshot,
							rootFile,
							t("sidebar:fileTree.compileFailed"),
						),
					]
				: []),
		];
		// Errors (red) lead the card and the build-log list; the sort is stable,
		// so each severity keeps its original order.
		return sortBySeverity(collected);
	}, [compileProblems, key, lint, requirementRows, rootFile, snapshot, t]);
	const counts = { error: 0, warning: 0, info: 0 };
	for (const row of rows) counts[row.severity] += 1;
	const shown = (["error", "warning", "info"] as const).filter(
		(severity) => counts[severity] > 0,
	);
	// Colour the icon itself, not the ghost button: the button's hover / open
	// state repaints its text to foreground, which would turn a red alert white.
	const tone =
		counts.error > 0
			? "text-destructive"
			: counts.warning > 0
				? "text-amber-600 dark:text-amber-500"
				: counts.info > 0
					? "text-sky-600 dark:text-sky-500"
					: "text-muted-foreground";

	// The row being inspected: the last one picked, else the first error, so the
	// dialog always shows which problem it is looking at (and which one
	// "Fix with Agent" targets).
	const activeRow =
		rows.find((row) => row.key === selected) ??
		rows.find((row) => row.severity === "error") ??
		rows[0];

	function askAgent(row: Row) {
		const detail = row.buildLog?.detail?.trim();
		const selection = createSelectionContext({
			// The headline stays first so chips and the sent message read as a
			// summary; the raw tail rides along as the Agent's evidence.
			text: detail ? `${row.message}\n\n${detail}` : row.message,
			sourcePath: row.sourcePath,
			origin: "markdown",
			...(row.buildLog
				? {
						surface: "build-log" as const,
						sourceTitle: `${t("log")} · ${basenameOf(rootFile)}`,
					}
				: {}),
			lineFrom: row.line,
			lineTo: row.line,
			comment: t("askAgentPrompt"),
		});
		if (!selection) return;
		pinSelection(selection);
		presentAgentComposer();
	}

	function focusLog(row: Row) {
		setSelected(row.key);
		setListOpen(false);
		setOpen(true);
		const line = row.logLine;
		if (line == null) return;
		requestAnimationFrame(() => {
			const node = logRef.current;
			if (!node) return;
			const height = 16;
			node.scrollTop = Math.max(0, line * height - height * 2);
		});
	}

	return (
		<>
			<Popover open={listOpen} onOpenChange={setListOpen}>
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="shrink-0"
						aria-label={
							shown.length
								? shown
										.map((severity) =>
											t(`viewer:textEditor.${severity}Count`, {
												count: counts[severity],
											}),
										)
										.join(", ")
								: t("problems")
						}
						title={t("problems")}
					>
						<TriangleAlert aria-hidden className={tone} />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-80 gap-1 p-1.5">
					{rows.length === 0 ? (
						<p className="text-muted-foreground px-2 py-1.5 text-xs">
							{t("noProblems")}
						</p>
					) : (
						rows.slice(0, 8).map((row) => {
							const { Icon, iconClasses } = SEVERITY_META[row.severity];
							return (
								<div
									key={row.key}
									className="flex items-start gap-1 rounded px-1 py-1 hover:bg-muted"
								>
									<button
										type="button"
										className="flex min-w-0 flex-1 items-start gap-2 px-1 py-0.5 text-left"
										onClick={() => {
											row.jump();
											focusLog(row);
										}}
									>
										<Icon
											className={cn("mt-0.5 size-3.5 shrink-0", iconClasses)}
											aria-hidden
										/>
										<span
											className="line-clamp-2 min-w-0 flex-1 break-words text-xs leading-snug"
											title={row.message}
										>
											{row.message}
										</span>
										{row.where ? (
											<span className="min-w-6 shrink-0 text-right font-mono text-[0.65rem] text-muted-foreground">
												{row.where}
											</span>
										) : null}
									</button>
								</div>
							);
						})
					)}
					<button
						type="button"
						className="text-muted-foreground hover:text-foreground mt-0.5 flex w-full items-center gap-2 rounded border-t border-border px-2 py-1.5 text-left text-xs hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
						onClick={() => {
							setListOpen(false);
							setOpen(true);
						}}
					>
						<FileText className="size-3.5 shrink-0" aria-hidden />
						{t("log")}
					</button>
				</PopoverContent>
			</Popover>
			<Dialog open={open} onOpenChange={setOpen}>
				<DialogContent
					className="flex h-[70vh] flex-col gap-3 sm:max-w-4xl"
					aria-describedby={undefined}
				>
					<div className="flex items-center justify-between gap-3 pr-8">
						<DialogTitle>
							{t("log")} · {basenameOf(rootFile)}
						</DialogTitle>
						<div className="flex items-center gap-2">
							{activeRow ? (
								<Button
									type="button"
									variant="secondary"
									size="sm"
									onClick={() => {
										setOpen(false);
										askAgent(activeRow);
									}}
								>
									<MessageSquarePlus className="size-3.5" aria-hidden />
									{t("fixWithAgent")}
								</Button>
							) : null}
							{snapshot?.status === "running" && snapshot.jobId ? (
								<Button
									type="button"
									variant="ghost"
									size="sm"
									onClick={() => {
										if (snapshot.jobId) cancelTask(snapshot.jobId);
									}}
								>
									<Square className="size-3.5" aria-hidden />
									{t("stop")}
								</Button>
							) : null}
						</div>
					</div>
					<div className="flex min-h-0 flex-1 gap-3">
						<div className="flex w-72 shrink-0 flex-col overflow-auto rounded-md border border-border">
							{rows.length === 0 ? (
								<p className="text-muted-foreground px-3 py-2 text-xs">
									{t("noProblems")}
								</p>
							) : (
								rows.map((row) => {
									const { Icon, iconClasses } = SEVERITY_META[row.severity];
									const active = activeRow?.key === row.key;
									return (
										<button
											key={row.key}
											type="button"
											aria-current={active ? "true" : undefined}
											className={cn(
												"flex w-full items-start gap-2 border-b border-border px-2 py-1.5 text-left last:border-b-0",
												FILE_TREE_ROW_STATE,
												active && FILE_TREE_ROW_SELECTED_STATE,
											)}
											onClick={() => {
												row.jump();
												focusLog(row);
											}}
										>
											<Icon
												className={cn("mt-0.5 size-3.5 shrink-0", iconClasses)}
												aria-hidden
											/>
											<span
												className="line-clamp-3 min-w-0 flex-1 break-words text-xs leading-snug"
												title={row.message}
											>
												{row.message}
											</span>
										</button>
									);
								})
							)}
						</div>
						<textarea
							ref={logRef}
							readOnly
							aria-label={t("log")}
							spellCheck={false}
							className="min-h-0 min-w-0 flex-1 resize-none overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-3 font-mono text-xs leading-4 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
							value={logText || t("noLog")}
						/>
					</div>
				</DialogContent>
			</Dialog>
		</>
	);
}

function editorRow(
	diagnostic: EditorDiagnostic,
	path: string,
	jump: (diagnostic: EditorDiagnostic) => void,
): Row {
	return {
		key: `editor:${diagnostic.from}:${diagnostic.to}:${diagnostic.message}`,
		severity: diagnostic.severity,
		message: diagnostic.message,
		where: `${diagnostic.line}:${diagnostic.column}`,
		logLine: null,
		sourcePath: path,
		line: diagnostic.line,
		jump: () => jump(diagnostic),
	};
}

/** A failed build whose log has no parsable error still gets one row. */
function buildFailureRow(
	snapshot: TexBuildSnapshot,
	rootFile: string,
	fallback: string,
): Row {
	// The Host reports the console tail, not a single message: keep it as the
	// Agent's evidence but show a one-line headline in the list.
	const detail = snapshot.diagnostics.find(
		(item) => item.severity === "error",
	)?.message;
	const headline = detail ? compileFailureHeadline(detail) : null;
	const message = headline ?? fallback;
	return {
		key: `build:${message}`,
		severity: "error",
		message,
		where: "",
		logLine: null,
		sourcePath: rootFile,
		jump: () => {},
		buildLog: detail ? { detail } : {},
	};
}

function requirementMessage(
	translate: ReturnType<typeof useTranslation<["latexBuild"]>>["t"],
	id: TexRequirement["id"],
): string {
	switch (id) {
		case "minted":
			return translate("requirement.minted");
		case "glossaries":
			return translate("requirement.glossaries");
		case "pythontex":
			return translate("requirement.pythontex");
		case "shellEscape":
			return translate("requirement.shellEscape");
	}
}

function requirementRow(
	path: string,
	requirement: TexRequirement,
	message: string,
): Row {
	return {
		key: `requirement:${normalizePath(path)}:${requirement.id}`,
		severity: "info",
		message,
		where: String(requirement.line),
		logLine: null,
		sourcePath: path,
		line: requirement.line,
		jump: () => navigateTexSource(path, requirement.line),
	};
}

function compileRow(problem: LogProblem, rootFile: string): Row {
	return {
		key: `log:${problem.logLine}:${problem.message}`,
		severity: problem.severity,
		message: problem.message,
		where: problem.line ? String(problem.line) : "",
		logLine: problem.logLine,
		sourcePath: resolveLogProblemPath(rootFile, problem.file),
		line: problem.line,
		buildLog: {},
		jump: () => jumpToCompileProblem(rootFile, problem),
	};
}

function jumpToCompileProblem(rootFile: string, problem: LogProblem) {
	if (!problem.line) return;
	const lint = editorLintStore.getState().current;
	const target = resolveLogProblemPath(rootFile, problem.file);
	if (
		lint &&
		target &&
		normalizePath(lint.path) === normalizePath(target) &&
		lint.jumpToLine
	) {
		lint.jumpToLine(problem.line);
		return;
	}
	if (!target) return;
	pendingEditorLineJump.setState({
		path: normalizePath(target),
		line: problem.line,
	});
	navigateTexSource(target, problem.line);
}
