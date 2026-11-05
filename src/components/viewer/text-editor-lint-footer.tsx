import { forEachDiagnostic, setDiagnosticsEffect } from "@codemirror/lint";
import type { EditorState, Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { LucideIcon } from "lucide-react";
import { Check, CircleAlert, Copy, Info, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { cn } from "@/lib/core/utils";
import type {
	EditorDiagnostic,
	LintSeverity,
} from "@/lib/tex/editor-diagnostic";

/**
 * IDE-style lint status bar for the text editor: per-severity counts
 * (error / warning / info) with an icon, and a hover card listing every
 * diagnostic — click a card to jump to the offending span.
 */

export type {
	EditorDiagnostic,
	LintSeverity,
} from "@/lib/tex/editor-diagnostic";

/**
 * Collect the current lint diagnostics with 1-based line/column, in document
 * order. Severity-less diagnostics default to warning so the footer never
 * drops a finding.
 */
export function collectEditorDiagnostics(
	state: EditorState,
): EditorDiagnostic[] {
	const found: EditorDiagnostic[] = [];
	forEachDiagnostic(state, (diagnostic, from, to) => {
		const severity: LintSeverity =
			diagnostic.severity === "error" || diagnostic.severity === "info"
				? diagnostic.severity
				: "warning";
		const line = state.doc.lineAt(from);
		found.push({
			from,
			to,
			severity,
			message: diagnostic.message,
			...(diagnostic.source ? { source: diagnostic.source } : {}),
			line: line.number,
			column: from - line.from + 1,
		});
	});
	found.sort((a, b) => a.from - b.from || a.to - b.to);
	return found;
}

/**
 * Push the diagnostics to React whenever a lint run lands. The lint state
 * field is private to @codemirror/lint, but its setDiagnostics effect is the
 * public signal that a run replaced the markers.
 */
export function lintDiagnosticsWatcher(
	onDiagnostics: (diagnostics: EditorDiagnostic[]) => void,
): Extension {
	return EditorView.updateListener.of((update) => {
		const replaced = update.transactions.some((tr) =>
			tr.effects.some((effect) => effect.is(setDiagnosticsEffect)),
		);
		if (!replaced) return;
		onDiagnostics(collectEditorDiagnostics(update.state));
	});
}

// Literal keys keep react-i18next's typed t() on the (key, options)
// overload — a plain `string` key falls through to (key, defaultValue).
type CountKey =
	| "textEditor.errorCount"
	| "textEditor.warningCount"
	| "textEditor.infoCount";

export const SEVERITY_META: Record<
	LintSeverity,
	{ Icon: LucideIcon; iconClasses: string; countKey: CountKey }
> = {
	error: {
		Icon: CircleAlert,
		iconClasses: "text-destructive",
		countKey: "textEditor.errorCount",
	},
	warning: {
		Icon: TriangleAlert,
		iconClasses: "text-amber-600 dark:text-amber-500",
		countKey: "textEditor.warningCount",
	},
	info: {
		Icon: Info,
		iconClasses: "text-sky-600 dark:text-sky-500",
		countKey: "textEditor.infoCount",
	},
};

const SEVERITY_ORDER: LintSeverity[] = ["error", "warning", "info"];

/** Include the exact location and rule message when sharing findings with an agent. */
export function formatEditorDiagnostic(
	diagnostic: EditorDiagnostic,
	path: string,
): string {
	return `${path ? `${path}:` : ""}${diagnostic.line}:${diagnostic.column} [${diagnostic.severity}]\n${diagnostic.message}`;
}

/** ChkTeX-only diagnostics keep the original lightweight hover/focus list. */
export function TextEditorLintFooter({
	diagnostics,
	onJump,
	path = "",
	chrome = "footer",
}: {
	diagnostics: EditorDiagnostic[];
	onJump: (diagnostic: EditorDiagnostic) => void;
	path?: string;
	/** `inline` sits in the writing PDF bar and opens the list downward. */
	chrome?: "footer" | "inline";
}) {
	const { t } = useTranslation("viewer");
	const { t: tb } = useTranslation("latexBuild");
	const [copiedKey, setCopiedKey] = useState<string | null>(null);
	useEffect(() => {
		if (copiedKey === null) return;
		const timeout = setTimeout(() => setCopiedKey(null), 1500);
		return () => clearTimeout(timeout);
	}, [copiedKey]);
	const counts: Record<LintSeverity, number> = {
		error: 0,
		warning: 0,
		info: 0,
	};
	for (const diagnostic of diagnostics) counts[diagnostic.severity] += 1;
	const shown =
		chrome === "inline"
			? SEVERITY_ORDER.filter((severity) => counts[severity] > 0)
			: SEVERITY_ORDER;
	if (chrome === "inline" && shown.length === 0) return null;
	return (
		<div
			className={
				chrome === "inline"
					? "flex shrink-0 items-center"
					: "flex h-7 shrink-0 items-center border-t bg-muted/30 px-3"
			}
		>
			<div
				className={cn(
					"group/lint relative flex items-center",
					chrome === "inline" ? "gap-2" : "gap-3",
				)}
			>
				<button
					type="button"
					className={cn(
						"flex min-h-7 items-center rounded focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
						chrome === "inline" ? "gap-2" : "gap-3",
					)}
					aria-label={shown
						.map((severity) =>
							t(SEVERITY_META[severity].countKey, {
								count: counts[severity],
							}),
						)
						.join(", ")}
				>
					{shown.map((severity) => {
						const { Icon, iconClasses, countKey } = SEVERITY_META[severity];
						const count = counts[severity];
						return (
							<span
								key={severity}
								className={cn(
									"flex items-center gap-1 font-mono text-xs text-muted-foreground",
									count === 0 && "opacity-45",
								)}
							>
								<Icon className={cn("size-3.5", iconClasses)} aria-hidden />
								{count}
								<span className="sr-only">{t(countKey, { count })}</span>
							</span>
						);
					})}
				</button>
				{diagnostics.length ? (
					<div
						className={cn(
							"pointer-events-none invisible absolute left-0 z-20 max-h-72 w-[28rem] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-lg border bg-popover p-1.5 text-foreground opacity-0 shadow-overlay ring-1 ring-foreground/10 group-hover/lint:pointer-events-auto group-hover/lint:visible group-hover/lint:opacity-100 group-focus-within/lint:pointer-events-auto group-focus-within/lint:visible group-focus-within/lint:opacity-100",
							chrome === "inline" ? "top-full mt-1" : "bottom-full",
						)}
					>
						{diagnostics.map((diagnostic) => {
							const key = `${diagnostic.from}:${diagnostic.to}:${diagnostic.message}`;
							const { Icon, iconClasses } = SEVERITY_META[diagnostic.severity];
							return (
								<div
									key={key}
									className="group/diagnostic relative rounded hover:bg-accent focus-within:bg-accent"
								>
									<button
										type="button"
										className="flex w-full min-w-0 select-text items-start gap-2 rounded px-2 py-1.5 text-left focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
										onClick={(event) => {
											const selection = window.getSelection();
											// A drag should leave the selected message ready for native copy.
											if (
												event.detail > 0 &&
												selection &&
												!selection.isCollapsed &&
												(event.currentTarget.contains(selection.anchorNode) ||
													event.currentTarget.contains(selection.focusNode))
											)
												return;
											onJump(diagnostic);
										}}
									>
										<Icon
											className={cn("mt-0.5 size-3.5 shrink-0", iconClasses)}
											aria-hidden
										/>
										<span className="min-w-0 flex-1 break-words text-xs leading-snug">
											{diagnostic.message}
										</span>
										<span
											className="min-w-6 shrink-0 text-right font-mono text-[0.65rem] text-muted-foreground group-hover/diagnostic:invisible group-focus-within/diagnostic:invisible [@media(hover:none)]:invisible"
											title={
												path
													? `${path}:${diagnostic.line}:${diagnostic.column}`
													: undefined
											}
										>
											{diagnostic.line}:{diagnostic.column}
										</span>
									</button>
									<button
										type="button"
										className="absolute right-1 top-1 flex size-6 items-center justify-center rounded text-muted-foreground opacity-0 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring group-hover/diagnostic:opacity-100 group-focus-within/diagnostic:opacity-100 [@media(hover:none)]:opacity-100"
										aria-label={tb("copyProblem")}
										title={tb("copyProblem")}
										onClick={async () => {
											if (
												await copyTextToClipboard(
													formatEditorDiagnostic(diagnostic, path),
													{ errorMessage: tb("copyFailed") },
												)
											)
												setCopiedKey(key);
										}}
									>
										{copiedKey === key ? (
											<Check className="size-3.5" aria-hidden />
										) : (
											<Copy className="size-3.5" aria-hidden />
										)}
									</button>
								</div>
							);
						})}
					</div>
				) : null}
			</div>
		</div>
	);
}
