import { CheckCircle2, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
	settingsCardClassName,
	settingsRowClassName,
} from "@/components/settings/settings-layout";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/core/utils";
import type { DoctorIssue, WikiCheckIssue } from "@/lib/doctor/api";
import {
	measureMonoText,
	splitLineAroundFocus,
	useWindowedLine,
} from "./doctor-line-fit";

/** Section title with status on the right; issue list below when present. */
export function DoctorSection({
	title,
	description,
	ok,
	issueCount,
	action,
	/** Cap list height and scroll (wikilinks / aliases with many rows). */
	scrollable = false,
	/** Wrap children in a single bordered card (disable for per-item cards). */
	framed = true,
	/** Short muted rule under the section (omit on the last block). */
	showDivider = true,
	children,
}: {
	title: string;
	description?: string;
	ok: boolean;
	issueCount: number;
	action?: ReactNode;
	scrollable?: boolean;
	framed?: boolean;
	showDivider?: boolean;
	children?: ReactNode;
}) {
	const { t } = useTranslation("settings");
	const hasList = Boolean(children);

	return (
		<div className={showDivider ? "mb-2 pb-6" : "mb-5"}>
			<div className="mb-1 flex items-center gap-3 px-0.5">
				<p className="min-w-0 flex-1 font-medium text-sm text-foreground">
					{title}
				</p>
				<span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
					{ok ? (
						<CheckCircle2
							className="size-4 text-emerald-600 dark:text-emerald-500"
							aria-hidden
						/>
					) : (
						<TriangleAlert
							className="size-4 text-amber-600 dark:text-amber-500"
							aria-hidden
						/>
					)}
					{t("doctor.issueCount", { count: issueCount })}
				</span>
				{action}
			</div>
			{description ? (
				<p className="mb-2 px-0.5 text-muted-foreground text-xs leading-relaxed">
					{description}
				</p>
			) : null}
			{hasList ? (
				framed ? (
					<div
						className={cn(
							settingsCardClassName,
							scrollable &&
								"max-h-60 overflow-y-auto overflow-x-hidden overscroll-y-contain",
						)}
					>
						{children}
					</div>
				) : (
					children
				)
			) : null}
			{showDivider ? (
				<div className="mt-6 flex justify-center px-6" aria-hidden>
					<div className="h-px w-9/10 max-w-l bg-border/40" />
				</div>
			) : null}
		</div>
	);
}

export function IssueRows({ issues }: { issues: DoctorIssue[] }) {
	return (
		<>
			{issues.map((issue) => (
				<div
					key={`${issue.code}:${issue.path ?? ""}:${issue.message}`}
					className={cn(settingsRowClassName, "items-start")}
				>
					<div className="min-w-0">
						<p className="text-sm leading-snug text-foreground">
							{issue.message}
						</p>
						{issue.path ? (
							<p className="mt-0.5 truncate text-muted-foreground text-xs">
								{issue.path}
							</p>
						) : null}
					</div>
				</div>
			))}
		</>
	);
}

export function WikiIssueRows({ issues }: { issues: WikiCheckIssue[] }) {
	return (
		<>
			{issues.map((issue) => {
				const { before, after } = splitLineAroundFocus(
					issue.context ?? undefined,
					issue.targetRaw,
				);
				return (
					<div
						key={`${issue.source}:${issue.line}:${issue.targetRaw}:${issue.status}:${issue.context ?? ""}`}
						className={cn(settingsRowClassName, "items-start")}
					>
						<p className="truncate font-mono text-muted-foreground text-xs">
							{issue.source}:{issue.line}
						</p>
						<div className="mt-1 overflow-hidden rounded-md border font-mono text-xs">
							<GitLine
								sign="-"
								tone="bad"
								before={before}
								focus={issue.targetRaw}
								after={after}
							/>
						</div>
					</div>
				);
			})}
		</>
	);
}

/** One git-style line: full available width, focus centered, context truncated. */
export function GitLine({
	sign,
	tone,
	before,
	focus,
	after,
	focusNode,
}: {
	sign: "+" | "-";
	tone: "bad" | "good";
	before: string;
	focus: string;
	after: string;
	/** When set, replaces the static focus highlight (e.g. editable input). */
	focusNode?: ReactNode;
}) {
	const { ref, windowed } = useWindowedLine(before, focus, after);
	// Use palette red/emerald (not theme `destructive`) so the minus hunk stays
	// clearly red — `destructive` can read as charcoal on cream backgrounds.
	const focusClass =
		tone === "bad"
			? "shrink-0 rounded-sm bg-red-500/20 px-0.5 font-medium text-red-700 dark:bg-red-500/25 dark:text-red-300"
			: "shrink-0 rounded-sm bg-emerald-500/25 px-0.5 font-medium text-emerald-800 dark:text-emerald-300";
	const rowClass =
		tone === "bad"
			? "flex min-w-0 items-center bg-red-500/10 dark:bg-red-500/15"
			: "flex min-w-0 items-center bg-emerald-500/10 dark:bg-emerald-500/15";
	const signClass =
		tone === "bad"
			? "shrink-0 select-none px-2 py-1 text-red-600/80 dark:text-red-400/80"
			: "shrink-0 select-none px-2 py-1 text-emerald-700/80 dark:text-emerald-400/80";

	return (
		<div ref={ref} className={rowClass}>
			<span className={signClass}>{sign}</span>
			<span className="flex min-w-0 flex-1 items-center overflow-hidden whitespace-nowrap py-1 pr-2 leading-relaxed">
				{windowed.before ? (
					<span className="shrink-0 text-muted-foreground">
						{windowed.before}
					</span>
				) : null}
				{focusNode ?? <span className={focusClass}>{focus}</span>}
				{windowed.after ? (
					<span className="shrink-0 text-muted-foreground">
						{windowed.after}
					</span>
				) : null}
			</span>
		</div>
	);
}

/** Path header + red/green hunk; focus stays centered as the modal grows. */
export function WikiLinkDiff({
	source,
	line,
	prefix,
	suffix,
	oldText,
	newText,
	onNewTextChange,
	newTextAriaLabel,
}: {
	source: string;
	line: number;
	prefix?: string;
	suffix?: string;
	oldText: string;
	newText: string;
	onNewTextChange?: (value: string) => void;
	newTextAriaLabel?: string;
}) {
	const before = prefix ?? "";
	const after = suffix ?? "";
	return (
		<div className="min-w-0 flex-1">
			<p className="truncate font-mono text-muted-foreground text-xs">
				{source}:{line}
			</p>
			<div className="mt-1 overflow-hidden rounded-md border font-mono text-xs">
				<GitLine
					sign="-"
					tone="bad"
					before={before}
					focus={oldText}
					after={after}
				/>
				<GitLine
					sign="+"
					tone="good"
					before={before}
					focus={newText}
					after={after}
					focusNode={
						onNewTextChange ? (
							<Input
								aria-label={newTextAriaLabel}
								value={newText}
								onChange={(event) => onNewTextChange(event.currentTarget.value)}
								className="mx-0.5 h-6 min-w-[4rem] max-w-[min(100%,28rem)] border-0 bg-emerald-500/20 px-1.5 py-0 font-mono text-emerald-800 text-xs shadow-none focus-visible:border-0 focus-visible:ring-1 focus-visible:ring-emerald-500 dark:bg-emerald-500/25 dark:text-emerald-300"
								style={{
									// Prefer content width for CJK; still allow growth.
									width: `min(28rem, max(4rem, ${Math.ceil(measureMonoText(newText) + 16)}px))`,
								}}
							/>
						) : undefined
					}
				/>
			</div>
		</div>
	);
}
