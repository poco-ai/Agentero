/**
 * Problems from the editor and from the last compile, in one place.
 * One yellow alert entry opens the findings card; the card footer opens the
 * full build log (same findings, raw text on the right).
 */

import { FileText, MessageSquare, Square, TriangleAlert } from "lucide-react";
import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
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
import { texBuildStore } from "@/lib/tex/build-state";
import {
	editorLintStore,
	pendingEditorLineJump,
} from "@/lib/tex/editor-lint-bridge";
import { navigateTexSource } from "@/lib/tex/editor-navigation";
import {
	type LogProblem,
	parseLatexLog,
	resolveLogProblemPath,
} from "@/lib/tex/log-problems";

type Row = {
	key: string;
	severity: "error" | "warning" | "info";
	message: string;
	where: string;
	logLine: number | null;
	sourcePath: string;
	line?: number;
	jump: () => void;
};

export function WritingProblems({ rootFile }: { rootFile: string }) {
	const { t } = useTranslation(["latexBuild", "viewer"]);
	const key = normalizePath(rootFile);
	const snapshot = useStore(texBuildStore, (state) => state.byRoot[key]);
	const lint = useStore(editorLintStore, (state) => state.current);
	const [open, setOpen] = useState(false);
	const [listOpen, setListOpen] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const logRef = useRef<HTMLTextAreaElement>(null);
	const logText = snapshot?.logs.join("\n") ?? "";
	const compileProblems = useMemo(() => parseLatexLog(logText), [logText]);
	const rows = useMemo(
		() => [
			...(lint && normalizePath(lint.path) === key
				? lint.diagnostics.map((diagnostic) =>
						editorRow(diagnostic, lint.path, lint.jump),
					)
				: []),
			...compileProblems.map((problem) => compileRow(problem, rootFile)),
		],
		[compileProblems, key, lint, rootFile],
	);
	const counts = { error: 0, warning: 0, info: 0 };
	for (const row of rows) counts[row.severity] += 1;
	const shown = (["error", "warning", "info"] as const).filter(
		(severity) => counts[severity] > 0,
	);

	function askAgent(row: Row) {
		const selection = createSelectionContext({
			text: row.message,
			sourcePath: row.sourcePath,
			origin: "markdown",
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
						className="shrink-0 text-amber-600 dark:text-amber-500"
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
						<TriangleAlert aria-hidden />
					</Button>
				</PopoverTrigger>
				<PopoverContent align="start" className="w-80 gap-1 p-1">
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
										<span className="min-w-0 flex-1 text-xs leading-snug">
											{row.message}
										</span>
										{row.where ? (
											<span className="shrink-0 font-mono text-[0.65rem] text-muted-foreground">
												{row.where}
											</span>
										) : null}
									</button>
									<button
										type="button"
										aria-label={t("askAgent")}
										title={t("askAgent")}
										className="text-muted-foreground hover:text-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded"
										onClick={() => askAgent(row)}
									>
										<MessageSquare className="size-3.5" aria-hidden />
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
					<div className="flex min-h-0 flex-1 gap-3">
						<div className="flex w-72 shrink-0 flex-col overflow-auto rounded-md border border-border">
							{rows.length === 0 ? (
								<p className="text-muted-foreground px-3 py-2 text-xs">
									{t("noProblems")}
								</p>
							) : (
								rows.map((row) => {
									const { Icon, iconClasses } = SEVERITY_META[row.severity];
									return (
										<div
											key={row.key}
											className={cn(
												"flex items-start gap-1 border-b border-border px-1 py-1 last:border-b-0 hover:bg-muted",
												selected === row.key && "bg-muted",
											)}
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
													className={cn(
														"mt-0.5 size-3.5 shrink-0",
														iconClasses,
													)}
													aria-hidden
												/>
												<span className="min-w-0 flex-1 text-xs leading-snug">
													{row.message}
												</span>
											</button>
											<button
												type="button"
												aria-label={t("askAgent")}
												title={t("askAgent")}
												className="text-muted-foreground hover:text-foreground mt-0.5 flex size-6 shrink-0 items-center justify-center rounded"
												onClick={() => askAgent(row)}
											>
												<MessageSquare className="size-3.5" aria-hidden />
											</button>
										</div>
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

function compileRow(problem: LogProblem, rootFile: string): Row {
	return {
		key: `log:${problem.logLine}:${problem.message}`,
		severity: problem.severity,
		message: problem.message,
		where: problem.line ? String(problem.line) : "",
		logLine: problem.logLine,
		sourcePath: resolveLogProblemPath(rootFile, problem.file),
		line: problem.line,
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
