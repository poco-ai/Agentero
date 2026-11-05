import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { type PermissionRequest, respondPermission } from "@/lib/agent";

function formatPermissionKind(
	kind: string,
	t: (
		key:
			| "permission.kind.allowOnce"
			| "permission.kind.allowAlways"
			| "permission.kind.rejectOnce"
			| "permission.kind.rejectAlways",
	) => string,
): string {
	switch (kind) {
		case "allow_once":
			return t("permission.kind.allowOnce");
		case "allow_always":
			return t("permission.kind.allowAlways");
		case "reject_once":
			return t("permission.kind.rejectOnce");
		case "reject_always":
			return t("permission.kind.rejectAlways");
		default:
			return kind;
	}
}

export function AgentPermissionDialog({
	permissionRequest,
	onDismiss,
}: {
	permissionRequest: PermissionRequest | null;
	/** Clear local state after respond / close (caller owns the request). */
	onDismiss: () => void;
}) {
	const { t } = useTranslation("agent");

	return (
		<Dialog
			open={permissionRequest !== null}
			onOpenChange={(open) => {
				if (!open && permissionRequest) {
					void respondPermission(permissionRequest.requestId, null);
					onDismiss();
				}
			}}
		>
			<DialogContent className="max-w-md">
				{permissionRequest ? (
					<>
						<DialogHeader>
							<DialogTitle>{t("permission.title")}</DialogTitle>
							<DialogDescription>{permissionRequest.title}</DialogDescription>
						</DialogHeader>
						{permissionRequest.host ? (
							<p className="text-xs text-muted-foreground">
								{t("permission.remoteHost", { host: permissionRequest.host })}
							</p>
						) : null}
						{permissionRequest.paths.length ? (
							<div className="flex flex-col gap-1">
								{permissionRequest.paths.map((p) => (
									<code
										key={p}
										className="truncate rounded bg-muted px-1.5 py-0.5 text-xs"
										title={p}
									>
										{p}
									</code>
								))}
							</div>
						) : null}
						<DialogFooter className="flex-col items-stretch gap-2 sm:flex-col">
							{permissionRequest.options.map((opt) => (
								<Button
									key={opt.optionId}
									variant={opt.kind.startsWith("allow") ? "default" : "outline"}
									onClick={() => {
										void respondPermission(
											permissionRequest.requestId,
											opt.optionId,
										);
										onDismiss();
									}}
								>
									{opt.name || formatPermissionKind(opt.kind, t)}
								</Button>
							))}
							<Button
								variant="ghost"
								onClick={() => {
									void respondPermission(permissionRequest.requestId, null);
									onDismiss();
								}}
							>
								{t("permission.deny")}
							</Button>
						</DialogFooter>
					</>
				) : null}
			</DialogContent>
		</Dialog>
	);
}
