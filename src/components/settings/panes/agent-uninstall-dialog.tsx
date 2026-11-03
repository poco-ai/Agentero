import { Loader2 } from "lucide-react";
import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { AgentLogo } from "@/components/agent/agent-logo";
import { CompactCodeBlock } from "@/components/agent/rendering/code-block";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import type { AgentTemplate, UninstallInfo, UninstallScope } from "@/lib/agent";

export function AgentUninstallDialog({
	open,
	name,
	template,
	info,
	busy,
	onConfirm,
	onCancel,
}: {
	open: boolean;
	name: string;
	template: AgentTemplate | string | null | undefined;
	/** Null = registry-only removal (custom agents / no managed uninstall). */
	info: UninstallInfo | null;
	busy: boolean;
	onConfirm: (scope: UninstallScope) => void;
	onCancel: () => void;
}) {
	const { t } = useTranslation(["settings", "common"]);
	const agentId = useId();
	const acpId = useId();
	const [removeAgent, setRemoveAgent] = useState(false);
	const [removeAcp, setRemoveAcp] = useState(false);

	const hasAgent =
		info !== null &&
		(info.agent.npmCommands.length > 0 || info.agent.dirs.length > 0);
	const hasAcp =
		info !== null &&
		(info.acp.npmCommands.length > 0 || info.acp.dirs.length > 0);
	const hasPayload = hasAgent || hasAcp;
	const registryOnly = info !== null && !hasPayload;
	const showScopeChoices = hasAgent && hasAcp;

	useEffect(() => {
		if (!open) return;
		setRemoveAgent(hasAgent);
		setRemoveAcp(hasAcp);
	}, [open, hasAgent, hasAcp]);

	const scope: UninstallScope | null = showScopeChoices
		? removeAgent && removeAcp
			? "all"
			: removeAgent
				? "agent"
				: removeAcp
					? "acp"
					: null
		: hasPayload
			? "all"
			: null;

	const handleConfirm = () => {
		if (hasPayload) {
			if (!scope) return;
			onConfirm(scope);
		} else {
			onConfirm("all");
		}
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next && !busy) onCancel();
			}}
		>
			<DialogContent showCloseButton={false} className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<AgentLogo template={template} className="size-5" />
						{t("agent.uninstallDialog.title", { name })}
					</DialogTitle>
					<DialogDescription>
						{hasPayload ? (
							<span className="flex flex-col gap-3">
								<span>{t("agent.uninstallDialog.lead")}</span>
								{showScopeChoices ? (
									<span className="flex flex-col gap-2">
										<span className="flex items-center gap-2">
											<Checkbox
												id={agentId}
												checked={removeAgent}
												onCheckedChange={(checked) =>
													setRemoveAgent(checked === true)
												}
												disabled={busy}
											/>
											<Label
												htmlFor={agentId}
												className="cursor-pointer font-normal"
											>
												{t("agent.uninstallDialog.removeAgent")}
											</Label>
										</span>
										<span className="flex items-center gap-2">
											<Checkbox
												id={acpId}
												checked={removeAcp}
												onCheckedChange={(checked) =>
													setRemoveAcp(checked === true)
												}
												disabled={busy}
											/>
											<Label
												htmlFor={acpId}
												className="cursor-pointer font-normal"
											>
												{t("agent.uninstallDialog.removeAcp")}
											</Label>
										</span>
									</span>
								) : null}
								{info && (showScopeChoices ? removeAgent : hasAgent) ? (
									<UninstallScopeDetails
										scopeInfo={info.agent}
										copyAria={t("agent.uninstallDialog.copyAria")}
									/>
								) : null}
								{info && (showScopeChoices ? removeAcp : hasAcp) ? (
									<UninstallScopeDetails
										scopeInfo={info.acp}
										copyAria={t("agent.uninstallDialog.copyAria")}
									/>
								) : null}
							</span>
						) : registryOnly ? (
							t("agent.uninstallDialog.registryOnly")
						) : (
							t("agent.uninstallDialog.customConfirm")
						)}
					</DialogDescription>
				</DialogHeader>
				<DialogFooter className="gap-2 sm:gap-0">
					<Button
						type="button"
						variant="outline"
						onClick={onCancel}
						disabled={busy}
					>
						{t("common:cancel")}
					</Button>
					<Button
						type="button"
						variant="destructive"
						onClick={handleConfirm}
						disabled={busy || (hasPayload && !scope)}
					>
						{busy ? (
							<Loader2 className="size-3.5 animate-spin" aria-hidden />
						) : null}
						{t("agent.uninstallDialog.confirm")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function UninstallScopeDetails({
	scopeInfo,
	copyAria,
}: {
	scopeInfo: { npmCommands: string[]; dirs: string[] };
	copyAria: string;
}) {
	const { t } = useTranslation("settings");
	return (
		<span className="flex flex-col gap-1.5">
			{scopeInfo.npmCommands.length > 0 ? (
				<CompactCodeBlock
					code={scopeInfo.npmCommands.join("\n")}
					language="shell"
					wrap
					copyButtonProps={{ "aria-label": copyAria }}
				/>
			) : null}
			{scopeInfo.dirs.length > 0 ? (
				<span className="flex flex-col gap-1">
					<span className="font-medium text-foreground">
						{t("agent.uninstallDialog.dirsLabel")}
					</span>
					<CompactCodeBlock
						code={scopeInfo.dirs.join("\n")}
						language="shell"
						wrap
						copyButtonProps={{ "aria-label": copyAria }}
					/>
				</span>
			) : null}
		</span>
	);
}
