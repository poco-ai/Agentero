/**
 * Upload history, shown in the editor pane. Selecting a row shows that diff.
 */

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	useActiveWritingRoot,
	useWritingProjectRelative,
} from "@/hooks/use-writing-project";
import { errorText } from "@/lib/core/error";
import { notifyError, notifySuccess } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import { joinVaultPath } from "@/lib/vault/path";
import { reloadOpenWritingFiles } from "@/lib/writing/history";
import { writingStore } from "@/lib/writing/store";
import {
	loadWritingGitDiff,
	loadWritingGitLog,
	restoreWritingRevision,
	type WritingGitCommit,
	type WritingGitFile,
} from "@/lib/writing/sync";

export function WritingHistory() {
	const { t } = useTranslation("sidebar");
	const vault = useStore(writingStore, (state) => state.vaultPath);
	const activeRoot = useActiveWritingRoot();
	const projectRel = useWritingProjectRelative(vault, activeRoot);
	const projectDir =
		vault && projectRel ? joinVaultPath(vault, projectRel) : "";
	const [commits, setCommits] = useState<WritingGitCommit[]>([]);
	const [notice, setNotice] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [patch, setPatch] = useState("");
	const [patchLoading, setPatchLoading] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [restoring, setRestoring] = useState(false);
	const [revision, setRevision] = useState(0);

	useEffect(() => {
		if (!projectDir) return;
		const generation = revision;
		let cancelled = false;
		setLoading(true);
		setNotice(null);
		void loadWritingGitLog(projectDir)
			.then((log) => {
				if (cancelled || generation !== revision) return;
				setCommits(log.commits);
				setSelectedId((current) =>
					current && log.commits.some((commit) => commit.id === current)
						? current
						: (log.commits[0]?.id ?? null),
				);
				if (log.code === "git_missing") setNotice(t("writing.syncNoGit"));
				else if (log.commits.length === 0) setNotice(t("writing.historyEmpty"));
			})
			.catch((error: unknown) => {
				if (!cancelled) notifyError(errorText(error));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [projectDir, revision, t]);

	useEffect(() => {
		if (!projectDir || !selectedId) {
			setPatch("");
			return;
		}
		let cancelled = false;
		setPatchLoading(true);
		void loadWritingGitDiff(projectDir, selectedId)
			.then((diff) => {
				if (!cancelled) setPatch(diff.patch);
			})
			.catch((error: unknown) => {
				if (!cancelled) notifyError(errorText(error));
			})
			.finally(() => {
				if (!cancelled) setPatchLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [projectDir, selectedId]);

	const selected = commits.find((commit) => commit.id === selectedId) ?? null;
	const canRestore = selected != null && selected.id !== "pending";

	async function restore() {
		if (!projectDir || !selected || selected.id === "pending") return;
		setRestoring(true);
		try {
			const report = await restoreWritingRevision(projectDir, selected.id);
			if (report.code !== "restored") {
				notifyError(
					report.code === "git_missing"
						? t("writing.syncNoGit")
						: t("writing.historyEmpty"),
				);
				return;
			}
			reloadOpenWritingFiles();
			notifySuccess(t("writing.historyRestored"));
			setConfirming(false);
			setRevision((value) => value + 1);
		} catch (error) {
			notifyError(errorText(error));
		} finally {
			setRestoring(false);
		}
	}

	return (
		<div className="flex h-full min-h-0 min-w-0">
			<div className="flex w-56 shrink-0 flex-col border-r border-border">
				<div className="min-h-0 flex-1 overflow-auto p-2">
					{loading ? (
						<p className="text-muted-foreground px-2 py-1.5 text-xs">
							{t("writing.loading")}
						</p>
					) : null}
					{!loading && commits.length === 0 ? (
						<p className="text-muted-foreground flex h-full items-center justify-center px-3 text-center text-xs leading-relaxed">
							{notice}
						</p>
					) : null}
					{commits.map((commit) => (
						<button
							key={commit.id}
							type="button"
							aria-pressed={commit.id === selectedId}
							className={cn(
								"flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left hover:bg-muted",
								commit.id === selectedId && "bg-muted",
							)}
							onClick={() => setSelectedId(commit.id)}
						>
							<span className="text-xs tabular-nums">
								{commit.id === "pending"
									? t("writing.historyPending")
									: formatWhen(commit.at)}
							</span>
							<span className="text-muted-foreground w-full truncate text-xs">
								{fileLabel(commit.files)}
							</span>
						</button>
					))}
				</div>
				{canRestore ? (
					<div className="shrink-0 px-2 pb-2">
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="w-full"
							disabled={restoring}
							onClick={() => setConfirming(true)}
						>
							{t("writing.historyRestore")}
						</Button>
					</div>
				) : null}
			</div>
			<div className="min-h-0 min-w-0 flex-1 overflow-auto">
				{patchLoading ? (
					<p className="text-muted-foreground px-3 py-2 text-xs">
						{t("writing.loading")}
					</p>
				) : (
					<DiffDocument patch={patch} />
				)}
			</div>
			<Dialog
				open={confirming}
				onOpenChange={(next) => {
					if (!next) setConfirming(false);
				}}
			>
				<DialogContent className="sm:max-w-sm">
					<DialogTitle>{t("writing.historyRestore")}</DialogTitle>
					<DialogFooter>
						<Button
							type="button"
							disabled={restoring}
							onClick={() => void restore()}
						>
							{t("writing.historyRestore")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}

function DiffDocument({ patch }: { patch: string }) {
	const files = splitPatch(patch);
	if (files.length === 0) return null;
	return (
		<div className="flex flex-col">
			{files.map((file) => (
				<section key={file.path}>
					<h2 className="sticky top-0 border-b border-border bg-muted/80 px-3 py-1.5 font-mono text-xs">
						{file.path}
					</h2>
					<pre className="overflow-auto font-mono text-xs leading-5">
						{file.lines.map((line) => (
							<DiffLine key={line.key} line={line.text} />
						))}
					</pre>
				</section>
			))}
		</div>
	);
}

function DiffLine({ line }: { line: string }) {
	return <div className={cn("px-3", diffLineClass(line))}>{line || " "}</div>;
}

type DiffLineRow = { key: number; text: string };
type DiffFile = { path: string; lines: DiffLineRow[] };

function splitPatch(patch: string): DiffFile[] {
	const files: DiffFile[] = [];
	let current: DiffFile | null = null;
	let key = 0;
	for (const line of patch.split("\n")) {
		if (line.startsWith("diff --git ")) {
			const name = line.match(/ b\/(.+)$/)?.[1] ?? line;
			current = { path: name, lines: [] };
			files.push(current);
			continue;
		}
		if (!current) continue;
		if (
			line.startsWith("index ") ||
			line.startsWith("---") ||
			line.startsWith("+++")
		) {
			continue;
		}
		current.lines.push({ key, text: line });
		key += 1;
	}
	return files.filter((file) => file.lines.length > 0);
}

function fileLabel(files: readonly WritingGitFile[]): string {
	if (files.length === 0) return "";
	return files
		.map((file) => {
			const name = file.path.split(/[\\/]/).pop() || file.path;
			if (file.added === 0 && file.removed === 0) return name;
			return `${name} +${file.added} -${file.removed}`;
		})
		.join(", ");
}

function diffLineClass(line: string): string {
	if (line.startsWith("@@")) return "text-muted-foreground";
	if (line.startsWith("+")) return "bg-emerald-500/15";
	if (line.startsWith("-")) return "bg-red-500/15";
	return "";
}

function formatWhen(at: number): string {
	return new Intl.DateTimeFormat(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	}).format(new Date(at * 1000));
}
