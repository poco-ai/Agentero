import { Loader2, ShieldCheck, TriangleAlert, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { usePiProjectTrust } from "@/components/agent/hooks/use-pi-project-trust";
import { Button } from "@/components/ui/button";
import { QuietIconButton } from "@/components/ui/quiet-icon-button";
import type { AgentTemplate } from "@/lib/agent";

/**
 * One-line notice shown when Pi runs a local Vault that has trust-gated
 * project resources but no recorded trust. Headless `pi --mode rpc` cannot
 * answer Pi's "Trust project folder?" prompt, so `.agents/skills` and `.pi/*`
 * stay silent until the user trusts the folder here.
 */
export function PiProjectTrustNotice({
	vaultPath,
	agentId,
	template,
	disabled = false,
}: {
	vaultPath: string | null;
	agentId: string | null | undefined;
	template: AgentTemplate | null | undefined;
	disabled?: boolean;
}) {
	const { t } = useTranslation("agent");
	const { visible, trusting, dismiss, trust } = usePiProjectTrust({
		vaultPath,
		agentId,
		template,
	});
	if (!visible) return null;

	return (
		<div className="mx-3 mt-2 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
			<div className="flex items-start gap-2.5">
				<TriangleAlert
					className="mt-0.5 size-3.5 shrink-0 text-amber-600"
					aria-hidden
				/>
				<div className="min-w-0 flex-1">
					<div className="flex items-start gap-2">
						<p className="min-w-0 flex-1 font-medium text-xs leading-snug">
							{t("piTrust.title")}
						</p>
						<QuietIconButton
							aria-label={t("piTrust.dismiss")}
							title={t("piTrust.dismiss")}
							className="-mt-1 size-5"
							onClick={dismiss}
						>
							<X className="size-3" aria-hidden />
						</QuietIconButton>
					</div>
					<div className="mt-2 flex items-center gap-2">
						<p className="min-w-0 flex-1 text-muted-foreground text-xs leading-relaxed">
							{t("piTrust.description")}
						</p>
						<Button
							type="button"
							variant="outline"
							size="sm"
							className="h-7 shrink-0 gap-1 px-2 text-xs"
							disabled={disabled || trusting}
							onClick={() => void trust()}
						>
							{trusting ? (
								<Loader2 className="size-3 animate-spin" aria-hidden />
							) : (
								<ShieldCheck className="size-3" aria-hidden />
							)}
							{t("piTrust.action")}
						</Button>
					</div>
				</div>
			</div>
		</div>
	);
}
