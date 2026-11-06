import {
	Check,
	ChevronDown,
	Circle,
	Folder,
	Laptop,
	LogOut,
	QrCode,
	X,
} from "lucide-react";
import { type TouchEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import agenteroLogo from "@/assets/agentero-logo.svg";
import { Button } from "@/components/ui/button";
import type { BridgeClientStatus } from "@/lib/bridge/client";
import { bridgeDisconnect } from "@/lib/bridge/client";
import { cn } from "@/lib/core/utils";

export function MobileSidebar({
	open,
	status,
	onClose,
	onStatus,
	onPairAnother,
}: {
	open: boolean;
	status: BridgeClientStatus;
	onClose: () => void;
	onStatus: (status: BridgeClientStatus) => void;
	onPairAnother: () => void;
}) {
	const { t } = useTranslation("mobile");
	const touchStartRef = useRef<{ x: number; y: number } | null>(null);
	const [expandedDevice, setExpandedDevice] = useState(true);

	useEffect(() => {
		if (!open) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [onClose, open]);

	const disconnect = async () => {
		await bridgeDisconnect();
		onStatus({ connected: false, paired: false });
		onClose();
	};

	const handleTouchStart = (event: TouchEvent<HTMLElement>) => {
		const touch = event.touches[0];
		if (touch) {
			touchStartRef.current = { x: touch.clientX, y: touch.clientY };
		}
	};

	const handleTouchEnd = (event: TouchEvent<HTMLElement>) => {
		const start = touchStartRef.current;
		touchStartRef.current = null;
		if (!start) return;
		const touch = event.changedTouches[0];
		if (!touch) return;
		const deltaX = touch.clientX - start.x;
		const deltaY = Math.abs(touch.clientY - start.y);
		if (deltaX < -60 && Math.abs(deltaX) > deltaY * 1.25) {
			onClose();
		}
	};

	return (
		<div
			className={cn(
				"fixed inset-0 z-40 transition-[visibility] duration-200",
				open ? "visible" : "invisible",
			)}
			aria-hidden={!open}
		>
			<button
				type="button"
				className={cn(
					"absolute inset-0 bg-black/30 transition-opacity duration-200 ease-out",
					open ? "opacity-100" : "opacity-0",
				)}
				aria-label={t("settings.closeMenu")}
				tabIndex={open ? 0 : -1}
				onClick={onClose}
			/>
			<aside
				className={cn(
					"absolute inset-y-0 left-0 flex w-[min(20rem,85vw)] select-none flex-col border-r bg-background pt-[env(safe-area-inset-top)] shadow-dialog transition-transform duration-200 ease-out",
					open ? "translate-x-0" : "-translate-x-full",
				)}
				aria-label={t("settings.menu")}
				onTouchStart={handleTouchStart}
				onTouchEnd={handleTouchEnd}
			>
				<header className="flex h-16 shrink-0 items-center justify-between border-b px-4">
					<div className="flex items-center gap-2">
						<img src={agenteroLogo} alt="" className="size-8" />
						<span className="font-semibold text-base">Agentero</span>
					</div>
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						aria-label={t("settings.closeMenu")}
						onClick={onClose}
					>
						<X className="size-4" />
					</Button>
				</header>

				<div className="flex-1 overflow-y-auto px-4 py-5">
					<section className="rounded-xl border bg-background shadow-raised">
						<button
							type="button"
							aria-expanded={expandedDevice}
							className={cn(
								"flex min-h-20 w-full items-center gap-3 rounded-xl px-3 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring",
								expandedDevice && "rounded-b-none",
							)}
							onClick={() => setExpandedDevice((expanded) => !expanded)}
						>
							<div className="grid size-11 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
								<Laptop className="size-5" />
							</div>
							<div className="min-w-0 flex-1">
								<p className="truncate font-semibold text-base">
									{status.hostName ?? "-"}
								</p>
								<span
									className={cn(
										"mt-1 inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 font-medium text-xs",
										status.connected
											? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
											: "bg-muted text-muted-foreground",
									)}
								>
									<Circle
										className={cn(
											"size-2 fill-current",
											status.connected
												? "text-emerald-500"
												: "text-muted-foreground",
										)}
									/>
									{status.connected
										? t("settings.connected")
										: t("settings.offline")}
								</span>
							</div>
							<ChevronDown
								className={cn(
									"size-5 shrink-0 text-muted-foreground transition-transform",
									expandedDevice && "rotate-180",
								)}
							/>
						</button>
						{expandedDevice ? (
							<div className="border-t px-3 pt-1.5 pb-2">
								<div className="ml-[21px] border-border/70 border-l pt-1 pl-3">
									<button
										type="button"
										className="flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left outline-none transition-colors hover:bg-muted/40 focus-visible:ring-2 focus-visible:ring-ring"
										aria-pressed="true"
									>
										<Folder className="size-4 shrink-0 text-muted-foreground" />
										<span className="min-w-0 flex-1 truncate font-medium text-sm">
											{status.vaultName ?? "-"}
										</span>
										<Check className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
									</button>
									<button
										type="button"
										className="mt-0.5 flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2 text-left text-destructive outline-none transition-colors hover:bg-destructive/10 focus-visible:ring-2 focus-visible:ring-ring"
										onClick={() => void disconnect()}
									>
										<LogOut className="size-4 shrink-0" />
										<span className="min-w-0 flex-1 truncate font-medium text-sm">
											{t("settings.disconnect")}
										</span>
									</button>
								</div>
							</div>
						) : null}
					</section>
				</div>

				<footer className="border-t p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
					<Button
						type="button"
						size="lg"
						className="h-12 w-full justify-start gap-3 rounded-xl px-3 text-base"
						onClick={() => {
							onPairAnother();
							onClose();
						}}
					>
						<QrCode className="size-5 text-primary-foreground" />
						<span>{t("settings.addDevice")}</span>
					</Button>
				</footer>
			</aside>
		</div>
	);
}
