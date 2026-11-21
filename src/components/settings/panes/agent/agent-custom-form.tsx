import { Plus, X } from "lucide-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentLogo } from "@/components/agent/agent-logo";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { isTauri } from "@/lib/core/tauri";

export type CustomAgentFormDraft = {
	id?: string;
	supportsShell: boolean;
	env?: Record<string, string>;
	name: string;
	command: string;
	args: string;
};

/**
 * Custom agent row (+ toggle) and its inline add form. `onSubmit` persists the
 * agent and rescans; resolving false keeps the form open with the draft intact.
 */
export function AgentCustomForm({
	busy,
	onSubmit,
}: {
	busy: boolean;
	onSubmit: (draft: CustomAgentFormDraft) => Promise<boolean>;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const [adding, setAdding] = useState(false);
	const [formName, setFormName] = useState(() => t("agent.form.defaultName"));
	const [formCommand, setFormCommand] = useState("");
	const [supportsShell, setSupportsShell] = useState(false);
	const [formArgs, setFormArgs] = useState("");

	const onAddCustom = async () => {
		const done = await onSubmit({
			id: undefined,
			supportsShell,
			name: formName,
			command: formCommand,
			args: formArgs,
		});
		if (done) {
			setAdding(false);
			setSupportsShell(false);
			setFormCommand("");
			setFormArgs("");
		}
	};

	return (
		<>
			{/* Custom entry row — same row style as catalog agents; + expands the form */}
			<div className="flex items-center justify-between gap-3 border-b py-2.5 pr-1.5 pl-3.5 last:border-b-0">
				<div className="flex min-w-0 flex-1 items-center gap-4">
					<div className="flex w-32 shrink-0 items-center gap-2">
						<AgentLogo template="custom" />
						<span className="min-w-0 truncate font-medium text-sm">
							{t("agent.custom")}
						</span>
					</div>
				</div>
				<div className="flex h-7 w-20 shrink-0 items-center justify-center gap-1">
					<Button
						type="button"
						variant="ghost"
						size="icon-xs"
						className="size-7"
						disabled={!isTauri()}
						aria-label={adding ? t("common:cancel") : t("agent.addCustom")}
						title={adding ? t("common:cancel") : t("agent.addCustom")}
						onClick={() => setAdding((v) => !v)}
					>
						{adding ? (
							<X className="size-3.5" aria-hidden />
						) : (
							<Plus className="size-3.5" aria-hidden />
						)}
					</Button>
				</div>
			</div>
			{adding ? (
				<div className="space-y-2.5 border-b px-3.5 py-3 last:border-b-0">
					<p className="text-muted-foreground text-xs leading-relaxed">
						{t("agent.form.hint")}
					</p>
					<div className="space-y-1">
						<Label className="font-normal text-sm">
							{t("agent.form.name")}
						</Label>
						<Input
							value={formName}
							onChange={(e) => setFormName(e.target.value)}
							spellCheck={false}
						/>
					</div>
					<div className="space-y-1">
						<Label className="font-normal text-sm">
							{t("agent.form.command")}
						</Label>
						<Input
							value={formCommand}
							onChange={(e) => setFormCommand(e.target.value)}
							placeholder="opencode"
							spellCheck={false}
							autoComplete="off"
						/>
					</div>
					<div className="space-y-1">
						<Label className="font-normal text-sm">
							{t("agent.form.args")}
						</Label>
						<Input
							value={formArgs}
							onChange={(e) => setFormArgs(e.target.value)}
							placeholder="acp"
							spellCheck={false}
							autoComplete="off"
						/>
					</div>
					<ShellCapability value={supportsShell} onChange={setSupportsShell} />
					<div className="flex justify-end gap-1.5 pt-1">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => setAdding(false)}
						>
							{t("common:cancel")}
						</Button>
						<Button
							type="button"
							size="sm"
							disabled={!formCommand.trim() || busy}
							onClick={() => void onAddCustom()}
						>
							{t("common:save")}
						</Button>
					</div>
				</div>
			) : null}
		</>
	);
}

export function ShellCapability({
	value,
	onChange,
}: {
	value: boolean;
	onChange: (value: boolean) => void;
}) {
	const { t } = useTranslation("settings");
	return (
		<Label>
			<Checkbox
				checked={value}
				onCheckedChange={(checked) => onChange(checked === true)}
			/>
			{t("agent.form.supportsShell")}
		</Label>
	);
}
