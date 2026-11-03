/**
 * GitHub repository and upload schedule for one writing project. The upload
 * tab and its dialog share the same fields and preferences.
 */

import { Loader2 } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { notifySuccess } from "@/lib/core/notify";
import {
	normalizeBranch,
	parseGitHubRemote,
	readWritingGitHub,
	type WritingGitHubLink,
	writeWritingGitHub,
} from "@/lib/writing/github";
import {
	readWritingSyncPrefs,
	WRITING_SYNC_INTERVALS,
	type WritingSyncMode,
	writeWritingSyncPrefs,
} from "@/lib/writing/sync-prefs";

export function WritingSyncForm({
	vaultPath,
	project,
	submitLabel,
	busy = false,
	onSaved,
}: {
	vaultPath: string | null;
	/** Vault-relative project folder, which is also its repository root. */
	project: string | null;
	submitLabel?: string;
	busy?: boolean;
	onSaved?: (link: WritingGitHubLink) => void;
}) {
	const { t } = useTranslation(["settings", "sidebar"]);
	const id = useId();
	const ready = Boolean(vaultPath && project);
	const saved =
		vaultPath && project ? readWritingGitHub(vaultPath, project) : null;
	const [remote, setRemote] = useState(
		saved ? `https://github.com/${saved.label}` : "",
	);
	const [branch, setBranch] = useState(saved?.branch ?? "main");
	const [invalid, setInvalid] = useState(false);
	const storedSync = vaultPath ? readWritingSyncPrefs(vaultPath) : null;
	const [syncMode, setSyncMode] = useState<WritingSyncMode>(
		storedSync?.mode ?? "onCompile",
	);
	const [syncMinutes, setSyncMinutes] = useState(
		storedSync?.intervalMinutes ?? 15,
	);

	function save() {
		if (!vaultPath || !project) return;
		const parsed = parseGitHubRemote(remote);
		const nextBranch = normalizeBranch(branch);
		if (!parsed || !nextBranch) {
			setInvalid(true);
			return;
		}
		const link = {
			remote: parsed.remote,
			branch: nextBranch,
			label: parsed.label,
		};
		writeWritingGitHub(vaultPath, project, link);
		notifySuccess(t("writing.saved"));
		onSaved?.(link);
	}

	function saveSyncMode(mode: WritingSyncMode, minutes = syncMinutes) {
		if (!vaultPath) return;
		setSyncMode(mode);
		setSyncMinutes(minutes);
		writeWritingSyncPrefs(vaultPath, { mode, intervalMinutes: minutes });
	}

	return (
		<form
			className="flex flex-col gap-4"
			onSubmit={(event) => {
				event.preventDefault();
				save();
			}}
		>
			<div className="flex flex-col gap-1.5">
				<Label
					htmlFor={`${id}-remote`}
					className="text-muted-foreground text-xs"
				>
					{t("sidebar:writing.syncRemote")}
				</Label>
				<Input
					id={`${id}-remote`}
					value={remote}
					placeholder={t("sidebar:writing.syncRemotePlaceholder")}
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
					disabled={!ready}
					aria-invalid={invalid || undefined}
					onChange={(event) => {
						setRemote(event.target.value);
						setInvalid(false);
					}}
				/>
			</div>
			<div className="grid grid-cols-2 gap-3">
				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={`${id}-branch`}
						className="text-muted-foreground text-xs"
					>
						{t("sidebar:writing.syncBranch")}
					</Label>
					<Input
						id={`${id}-branch`}
						value={branch}
						autoCapitalize="off"
						autoCorrect="off"
						spellCheck={false}
						disabled={!ready}
						aria-invalid={invalid || undefined}
						onChange={(event) => {
							setBranch(event.target.value);
							setInvalid(false);
						}}
					/>
				</div>
				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={`${id}-mode`}
						className="text-muted-foreground text-xs"
					>
						{t("writing.uploadMode")}
					</Label>
					<Select
						value={syncMode}
						disabled={!ready}
						onValueChange={(value) => {
							if (
								value === "manual" ||
								value === "onCompile" ||
								value === "interval"
							) {
								saveSyncMode(value);
							}
						}}
					>
						<SelectTrigger id={`${id}-mode`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper" align="start">
							<SelectItem value="manual">
								{t("writing.uploadManual")}
							</SelectItem>
							<SelectItem value="onCompile">
								{t("writing.uploadOnCompile")}
							</SelectItem>
							<SelectItem value="interval">
								{t("writing.uploadInterval")}
							</SelectItem>
						</SelectContent>
					</Select>
				</div>
			</div>
			{syncMode === "interval" ? (
				<div className="flex flex-col gap-1.5">
					<Label
						htmlFor={`${id}-every`}
						className="text-muted-foreground text-xs"
					>
						{t("writing.uploadEvery")}
					</Label>
					<Select
						value={String(syncMinutes)}
						disabled={!ready}
						onValueChange={(value) => {
							const minutes = Number(value);
							if (WRITING_SYNC_INTERVALS.some((item) => item === minutes)) {
								saveSyncMode("interval", minutes);
							}
						}}
					>
						<SelectTrigger id={`${id}-every`} className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent position="popper" align="start">
							{WRITING_SYNC_INTERVALS.map((minutes) => (
								<SelectItem key={minutes} value={String(minutes)}>
									{t("writing.uploadMinutes", { count: minutes })}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : null}
			<div className="flex items-center gap-3">
				{invalid ? (
					<p className="text-destructive text-xs leading-snug">
						{t("sidebar:writing.syncInvalid")}
					</p>
				) : null}
				<Button type="submit" className="ml-auto" disabled={!ready || busy}>
					{busy ? (
						<>
							<Loader2 className="animate-spin" aria-hidden />
							{t("sidebar:writing.syncing")}
						</>
					) : (
						(submitLabel ?? t("writing.save"))
					)}
				</Button>
			</div>
		</form>
	);
}
