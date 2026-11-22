import { BrowserQRCodeReader, type IScannerControls } from "@zxing/browser";
import { Camera, Keyboard, Laptop, LoaderCircle, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import agenteroLogo from "@/assets/agentero-logo.svg";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import {
	type BridgeClientStatus,
	bridgeConnect,
	listenBridgeProgress,
	type PairPendingEvent,
} from "@/lib/bridge/client";

function isAndroid(): boolean {
	return /Android/i.test(navigator.userAgent);
}

function mobileDeviceName(): string {
	if (isAndroid()) return "Android";
	if (navigator.userAgent.includes("iPad")) return "iPad";
	return "iPhone";
}

function describeBridgeError(
	message: string | undefined,
	networkPermissionMessage: string,
): string | null {
	if (!message) return null;
	if (!isAndroid() && /operation not permitted/i.test(message)) {
		return networkPermissionMessage;
	}
	return message;
}

function useBridgeProgressToast() {
	const { t } = useTranslation("mobile");
	useEffect(() => {
		let dispose: (() => void) | undefined;
		let active = true;
		void listenBridgeProgress((phase) => {
			if (!active) return;
			const message = t(`connect.progress.${phase}`);
			if (phase === "connected") {
				toast.success(message, { id: "bridge-progress", duration: 2500 });
			} else {
				toast.loading(message, { id: "bridge-progress" });
			}
		}).then((fn) => {
			if (active) dispose = fn;
			else fn();
		});
		return () => {
			active = false;
			dispose?.();
			toast.dismiss("bridge-progress");
		};
	}, [t]);
}

export function MobilePairing({
	status,
	pending,
	initialOffer,
	onStatus,
	onDone,
}: {
	status: BridgeClientStatus;
	pending: PairPendingEvent | null;
	initialOffer: string | null;
	onStatus: (status: BridgeClientStatus) => void;
	onDone: () => void;
}) {
	const { t } = useTranslation("mobile");
	const [offerUrl, setOfferUrl] = useState("");
	const [connecting, setConnecting] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [scannerOpen, setScannerOpen] = useState(false);
	const [linkOpen, setLinkOpen] = useState(false);
	useBridgeProgressToast();

	const connect = useCallback(
		async (value: string) => {
			const offer = value.trim();
			if (!offer) return;
			setConnecting(true);
			setError(null);
			try {
				const next = await bridgeConnect({
					offerUrl: offer,
					deviceName: mobileDeviceName(),
				});
				setLinkOpen(false);
				onStatus(next);
				onDone();
			} catch (cause) {
				toast.dismiss("bridge-progress");
				setError(
					describeBridgeError(
						cause instanceof Error
							? cause.message
							: typeof cause === "string"
								? cause
								: undefined,
						t("errors.networkPermission"),
					) ?? t("errors.connect"),
				);
			} finally {
				setConnecting(false);
			}
		},
		[onStatus, onDone, t],
	);

	const handleScannedOffer = useCallback(
		(value: string) => {
			setScannerOpen(false);
			setOfferUrl(value);
			void connect(value);
		},
		[connect],
	);

	useEffect(() => {
		if (!initialOffer) return;
		setOfferUrl(initialOffer);
		setError(null);
		setLinkOpen(true);
	}, [initialOffer]);

	return (
		<div className="mobile-shell flex h-dvh min-h-0 w-full select-none flex-col overflow-hidden bg-background px-5 pt-[max(2rem,env(safe-area-inset-top))] pb-8 sm:px-8 md:mx-auto md:max-w-md">
			<div className="flex flex-1 flex-col items-center justify-center">
				<img src={agenteroLogo} alt="Agentero" className="size-28" />
				<h1 className="mt-6 font-semibold text-2xl">{t("connect.title")}</h1>
				<div className="mt-10 w-full space-y-3">
					<Button
						className="w-full"
						size="lg"
						disabled={connecting}
						onClick={() => {
							setError(null);
							setScannerOpen(true);
						}}
					>
						{connecting ? (
							<LoaderCircle className="size-4 animate-spin" />
						) : (
							<Camera className="size-4" />
						)}
						{connecting ? t("connect.connecting") : t("connect.camera")}
					</Button>
					<Button
						type="button"
						variant="outline"
						className="w-full"
						size="lg"
						disabled={connecting}
						onClick={() => {
							setError(null);
							setLinkOpen(true);
						}}
					>
						<Keyboard className="size-4" />
						{t("connect.manual")}
					</Button>
				</div>
				{pending ? (
					<div className="mt-8 w-full border-l-2 border-foreground px-4 py-2">
						<p className="text-sm">{t("connect.pending")}</p>
						<p className="mt-1 select-all font-mono text-2xl tabular-nums">
							{pending.verificationCode}
						</p>
					</div>
				) : null}
				{error || status.lastError ? (
					<p className="mt-4 w-full select-text text-destructive text-sm">
						{error ??
							describeBridgeError(
								status.lastError,
								t("errors.networkPermission"),
							)}
					</p>
				) : null}
			</div>
			{scannerOpen ? (
				<MobileQrScanner
					onClose={() => setScannerOpen(false)}
					onScan={handleScannedOffer}
				/>
			) : null}
			<MobilePairLinkDialog
				open={linkOpen}
				offerUrl={offerUrl}
				error={error}
				connecting={connecting}
				onOfferUrlChange={setOfferUrl}
				onOpenChange={setLinkOpen}
				onConnect={() => void connect(offerUrl)}
			/>
		</div>
	);
}

function MobilePairLinkDialog({
	open,
	offerUrl,
	error,
	connecting,
	onOfferUrlChange,
	onOpenChange,
	onConnect,
}: {
	open: boolean;
	offerUrl: string;
	error: string | null;
	connecting: boolean;
	onOfferUrlChange: (value: string) => void;
	onOpenChange: (open: boolean) => void;
	onConnect: () => void;
}) {
	const { t } = useTranslation("mobile");
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onOpenChange(false);
			}}
		>
			<DialogContent className="max-w-md rounded-lg">
				<DialogHeader>
					<DialogTitle>{t("connect.paste")}</DialogTitle>
				</DialogHeader>
				<Textarea
					value={offerUrl}
					onChange={(event) => onOfferUrlChange(event.target.value)}
					placeholder={t("connect.placeholder")}
					className="min-h-28 resize-none font-mono text-base md:text-xs"
					autoCapitalize="off"
					autoCorrect="off"
					spellCheck={false}
				/>
				{error ? <p className="text-destructive text-sm">{error}</p> : null}
				<DialogFooter>
					<Button disabled={connecting || !offerUrl.trim()} onClick={onConnect}>
						{connecting ? (
							<LoaderCircle className="size-4 animate-spin" />
						) : (
							<Laptop className="size-4" />
						)}
						{connecting ? t("connect.connecting") : t("connect.action")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

function MobileQrScanner({
	onClose,
	onScan,
}: {
	onClose: () => void;
	onScan: (value: string) => void;
}) {
	const { t } = useTranslation("mobile");
	const videoRef = useRef<HTMLVideoElement>(null);
	const controlsRef = useRef<IScannerControls | null>(null);
	const [failed, setFailed] = useState(false);

	useEffect(() => {
		const video = videoRef.current;
		if (!video) return;
		let active = true;
		const reader = new BrowserQRCodeReader();
		void reader
			.decodeFromConstraints(
				{ audio: false, video: { facingMode: { ideal: "environment" } } },
				video,
				(result, _error, controls) => {
					controlsRef.current = controls;
					if (!result || !active) return;
					controls.stop();
					onScan(result.getText());
				},
			)
			.then((controls) => {
				controlsRef.current = controls;
			})
			.catch(() => active && setFailed(true));
		return () => {
			active = false;
			controlsRef.current?.stop();
		};
	}, [onScan]);

	return (
		<div
			className="fixed inset-0 z-50 flex flex-col bg-background px-5 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))]"
			role="dialog"
			aria-modal="true"
			aria-label={t("connect.camera")}
		>
			<div className="flex items-center justify-between">
				<p className="font-medium text-sm">{t("connect.camera")}</p>
				<Button
					type="button"
					variant="ghost"
					size="icon-sm"
					aria-label={t("connect.cancel")}
					onClick={onClose}
				>
					<X className="size-4" />
				</Button>
			</div>
			<div className="relative my-auto aspect-square overflow-hidden border bg-black">
				<video
					ref={videoRef}
					className="size-full object-cover"
					muted
					playsInline
				/>
				<div className="pointer-events-none absolute inset-[15%] border-2 border-white/90" />
			</div>
			<p className="mt-5 text-center text-muted-foreground text-sm">
				{failed ? t("connect.cameraUnavailable") : t("connect.cameraHint")}
			</p>
		</div>
	);
}
