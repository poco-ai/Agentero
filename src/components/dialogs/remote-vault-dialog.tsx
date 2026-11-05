import { ChevronsUpDownIcon, ServerIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/core/utils";
import {
	remoteSshConfigHosts,
	type SshConfigHost,
} from "@/lib/vault/remote/remote-vault";

export type OpenRemoteVaultArgs = {
	host: string;
	remotePath: string;
};

function hostDetail(h: SshConfigHost): string {
	const hostPart = h.hostname ?? "";
	const userPart = h.user ? `${h.user}@` : "";
	const portPart = h.port ? `:${h.port}` : "";
	return `${userPart}${hostPart}${portPart}`;
}

/**
 * SSH/SFTP connect dialog — shared by welcome page and vault switcher.
 * The host field autocompletes from `~/.ssh/config` Host entries (#339).
 */
export function RemoteVaultDialog({
	open,
	onOpenChange,
	onConnect,
	busy,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConnect: (args: OpenRemoteVaultArgs) => void | Promise<void>;
	busy?: boolean;
}) {
	const { t } = useTranslation("app");
	const [host, setHost] = useState("");
	const [remotePath, setRemotePath] = useState("");
	const [connecting, setConnecting] = useState(false);
	const [sshHosts, setSshHosts] = useState<SshConfigHost[]>([]);
	const [suggestOpen, setSuggestOpen] = useState(false);
	const [activeIdx, setActiveIdx] = useState(0);
	const pathRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!open) return;
		let cancelled = false;
		remoteSshConfigHosts()
			.then((hosts) => {
				if (!cancelled) setSshHosts(hosts);
			})
			.catch(() => {
				if (!cancelled) setSshHosts([]);
			});
		return () => {
			cancelled = true;
		};
	}, [open]);

	const filtered = useMemo(() => {
		const q = host.trim().toLowerCase();
		if (!q) return sshHosts;
		return sshHosts.filter(
			(h) =>
				h.alias.toLowerCase().includes(q) ||
				(h.hostname ?? "").toLowerCase().includes(q) ||
				(h.user ?? "").toLowerCase().includes(q),
		);
	}, [sshHosts, host]);

	const showSuggestions =
		suggestOpen && sshHosts.length > 0 && filtered.length > 0;
	const disabled = connecting || Boolean(busy);

	const pickHost = (h: SshConfigHost) => {
		setHost(h.alias);
		setSuggestOpen(false);
		pathRef.current?.focus();
	};

	const onHostKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
		if (!showSuggestions) {
			if (e.key === "ArrowDown" && sshHosts.length > 0) {
				e.preventDefault();
				setActiveIdx(0);
				setSuggestOpen(true);
			}
			return;
		}
		switch (e.key) {
			case "ArrowDown":
				e.preventDefault();
				setActiveIdx((i) => (i + 1) % filtered.length);
				break;
			case "ArrowUp":
				e.preventDefault();
				setActiveIdx((i) => (i - 1 + filtered.length) % filtered.length);
				break;
			case "Enter":
				e.preventDefault();
				pickHost(filtered[Math.min(activeIdx, filtered.length - 1)]);
				break;
			case "Escape":
				e.preventDefault();
				setSuggestOpen(false);
				break;
		}
	};

	const submit = async () => {
		const h = host.trim();
		const p = remotePath.trim();
		if (!h || !p || connecting || busy) return;
		setConnecting(true);
		try {
			await onConnect({
				host: h,
				remotePath: p,
			});
			onOpenChange(false);
		} finally {
			setConnecting(false);
		}
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>{t("vault.remoteDialogTitle")}</DialogTitle>
				</DialogHeader>
				<div className="flex flex-col gap-3 py-1">
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="remote-host-shared">
							{t("vault.remoteHostLabel")}
						</Label>
						<div className="relative">
							<Input
								id="remote-host-shared"
								value={host}
								onChange={(e) => {
									setHost(e.target.value);
									setActiveIdx(0);
									setSuggestOpen(true);
								}}
								onFocus={() => setSuggestOpen(true)}
								onBlur={() => setSuggestOpen(false)}
								onKeyDown={onHostKeyDown}
								placeholder={t("vault.remoteHostPlaceholder")}
								autoComplete="off"
								disabled={disabled}
								role="combobox"
								aria-expanded={showSuggestions}
								aria-controls="remote-host-suggestions"
								className={cn(sshHosts.length > 0 && "pr-8")}
							/>
							{sshHosts.length > 0 && (
								<ChevronsUpDownIcon
									aria-hidden
									className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-muted-foreground"
								/>
							)}
							{showSuggestions && (
								<div
									id="remote-host-suggestions"
									role="listbox"
									className="absolute top-full right-0 left-0 z-50 mt-1 max-h-56 overflow-y-auto rounded-lg border bg-popover p-1.5 shadow-overlay ring-1 ring-foreground/10"
								>
									{filtered.map((h, i) => (
										<button
											key={h.alias}
											type="button"
											role="option"
											aria-selected={i === activeIdx}
											tabIndex={-1}
											className={cn(
												"flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm outline-none",
												i === activeIdx
													? "bg-muted text-foreground"
													: "text-popover-foreground",
											)}
											onMouseEnter={() => setActiveIdx(i)}
											onMouseDown={(e) => e.preventDefault()}
											onClick={() => pickHost(h)}
										>
											<span className="flex min-w-0 items-center gap-2">
												<ServerIcon
													aria-hidden
													className="size-3.5 shrink-0 opacity-60"
												/>
												<span className="truncate">{h.alias}</span>
											</span>
											{hostDetail(h) && (
												<span className="max-w-1/2 truncate text-xs text-muted-foreground">
													{hostDetail(h)}
												</span>
											)}
										</button>
									))}
								</div>
							)}
						</div>
					</div>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="remote-path-shared">
							{t("vault.remotePathLabel")}
						</Label>
						<Input
							id="remote-path-shared"
							ref={pathRef}
							value={remotePath}
							onChange={(e) => setRemotePath(e.target.value)}
							placeholder={t("vault.remotePathPlaceholder")}
							autoComplete="off"
							disabled={disabled}
						/>
					</div>
				</div>
				<DialogFooter>
					<Button
						type="button"
						variant="outline"
						disabled={disabled}
						onClick={() => onOpenChange(false)}
					>
						{t("vault.remoteCancel")}
					</Button>
					<Button
						type="button"
						disabled={disabled || !host.trim() || !remotePath.trim()}
						onClick={() => void submit()}
					>
						{connecting || busy
							? t("vault.remoteConnecting")
							: t("vault.remoteConnect")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
