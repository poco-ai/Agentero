import { ArrowRight, RefreshCw } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import type { AgentStepHandle } from "@/components/onboarding/steps/agent-step";
import { AgentStep } from "@/components/onboarding/steps/agent-step";
import { LayoutStep } from "@/components/onboarding/steps/layout-step";
import { NodeStep } from "@/components/onboarding/steps/node-step";
import { ProxyStep } from "@/components/onboarding/steps/proxy-step";
import { ThemeStep } from "@/components/onboarding/steps/theme-step";
import { TranslateStep } from "@/components/onboarding/steps/translate-step";
import { VaultChoiceStep } from "@/components/onboarding/steps/vault-choice-step";
import { WelcomeStep } from "@/components/onboarding/steps/welcome-step";
import { ThemeModeSwitch } from "@/components/onboarding/theme-mode-switch";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { useSettings, useVaultStore } from "@/hooks/use-app-stores";
import { perfActive } from "@/lib/core/perf";
import { isMobileApp, isTauri } from "@/lib/core/tauri";
import { cn } from "@/lib/core/utils";
import { listenOnboardingRequest } from "@/lib/onboarding/api";
import { patchSettings } from "@/lib/settings/react-store";
import { setZoteroOpen } from "@/lib/shell/ui-store";
import { createNewVault } from "@/lib/vault/actions";
import { vaultStore } from "@/lib/vault/store";
import { onboardingFlow } from "./flow";
import {
	closeOnboarding,
	onboardingStore,
	requestOnboarding,
} from "./onboarding-store";

const useOnboardingStepper = onboardingFlow.useStepper;

function FlowDots({ index, labels }: { index: number; labels: string[] }) {
	const { t } = useTranslation("common");
	return (
		<fieldset className="flex items-center gap-1.5">
			<legend className="sr-only">{t("steps")}</legend>
			{labels.map((label, i) => (
				<span
					key={label}
					role="status"
					aria-label={label}
					className={cn(
						"h-1.5 rounded-full transition-all",
						i === index
							? "w-5 bg-primary"
							: i < index
								? "w-1.5 bg-primary/50"
								: "w-1.5 bg-muted-foreground/25",
					)}
				/>
			))}
		</fieldset>
	);
}

export function OnboardingRoot() {
	const settings = useSettings((s) => s);
	const vaultPath = useVaultStore((s) => s.vaultPath);
	const recentVaults = useVaultStore((s) => s.recentVaults);
	const open = useStore(onboardingStore, (s) => s.open);
	const forceOpen = useStore(onboardingStore, (s) => s.forceOpen);
	const [zoteroOfferOpen, setZoteroOfferOpen] = useState(false);

	// Settings → main event: force the wizard open on demand.
	useEffect(() => {
		let cancelled = false;
		let unlisten: (() => void) | undefined;
		void listenOnboardingRequest(() => {
			if (!cancelled) requestOnboarding();
		}).then((off) => {
			if (cancelled) off();
			else unlisten = off;
		});
		return () => {
			cancelled = true;
			unlisten?.();
		};
	}, []);

	const shouldAutoShow = useMemo(
		() =>
			isTauri() &&
			!isMobileApp() &&
			!perfActive() &&
			!settings.onboardingDone &&
			!vaultPath &&
			recentVaults.length === 0,
		[settings.onboardingDone, vaultPath, recentVaults.length],
	);

	// Auto-show for fresh installs; close once completed or vault active.
	useEffect(() => {
		if (shouldAutoShow) {
			requestOnboarding();
		} else if (!forceOpen) {
			closeOnboarding();
		}
	}, [shouldAutoShow, forceOpen]);

	// Hard guarantee: once a vault is active the wizard must never cover it.
	useEffect(() => {
		if (vaultPath) closeOnboarding();
	}, [vaultPath]);

	if (!open && !zoteroOfferOpen) return null;

	return (
		<>
			{open ? (
				<OnboardingDialog onVaultCreated={() => setZoteroOfferOpen(true)} />
			) : null}
			<ZoteroImportOfferDialog
				open={zoteroOfferOpen}
				onOpenChange={setZoteroOfferOpen}
				onImport={() => {
					setZoteroOfferOpen(false);
					closeOnboarding();
					setZoteroOpen(true);
				}}
				onLater={() => {
					setZoteroOfferOpen(false);
					patchSettings({ onboardingDone: true });
				}}
			/>
		</>
	);
}

function OnboardingDialog({ onVaultCreated }: { onVaultCreated: () => void }) {
	const { t } = useTranslation("onboarding");
	const stepper = useOnboardingStepper();
	const settings = useSettings((s) => s);
	const patch = patchSettings;
	const agentStepRef = useRef<AgentStepHandle>(null);

	const stepLabels = onboardingFlow.steps.map((step) => t(`steps.${step.id}`));

	const nextLabel = stepper.isLast
		? t("actions.finish")
		: stepper.isFirst
			? t("actions.start")
			: t("actions.next");

	const onNext = () => {
		if (stepper.isLast) {
			finish();
			return;
		}
		void stepper.next();
	};

	const finish = () => {
		patch({ onboardingDone: true });
		void import("@/lib/activity").then(({ track }) => {
			track("onboarding.complete");
		});
		closeOnboarding();
	};

	const onCreateVault = () => {
		void (async () => {
			await createNewVault();
			// The vault must exist before the user can choose a Zotero source.
			if (vaultStore.getState().vaultPath) onVaultCreated();
		})();
	};

	const renderStep = () => {
		switch (stepper.current.id) {
			case "welcome":
				return <WelcomeStep />;
			case "theme":
				return <ThemeStep settings={settings} patch={patch} />;
			case "proxy":
				return <ProxyStep settings={settings} patch={patch} />;
			case "node":
				return <NodeStep />;
			case "agent":
				return <AgentStep ref={agentStepRef} />;
			case "translate":
				return <TranslateStep settings={settings} patch={patch} />;
			case "layout":
				return <LayoutStep settings={settings} patch={patch} />;
			case "vault":
				return <VaultChoiceStep onCreate={onCreateVault} />;
		}
	};

	const currentCopy = (() => {
		switch (stepper.current.id) {
			case "theme":
				return { title: t("theme.title"), desc: t("theme.desc") };
			case "proxy":
				return { title: t("proxy.title"), desc: t("proxy.desc") };
			case "node":
				return { title: t("node.title"), desc: t("node.desc") };
			case "agent":
				return { title: t("agent.title"), desc: t("agent.desc") };
			case "translate":
				return { title: t("translate.title"), desc: t("translate.desc") };
			case "layout":
				return { title: t("layout.title"), desc: t("layout.desc") };
			case "vault":
				return { title: t("vault.title"), desc: t("vault.desc") };
			default:
				return undefined;
		}
	})();
	const stepTitle = currentCopy?.title ?? t(`steps.${stepper.current.id}`);
	const stepDesc = currentCopy?.desc;

	return (
		<div className="fixed inset-0 z-40 flex select-none items-center justify-center bg-background p-6">
			<div
				aria-hidden
				className="pointer-events-none absolute inset-0 overflow-hidden"
			>
				<div className="absolute -top-32 -left-24 size-96 rounded-full bg-primary/10 blur-3xl" />
				<div className="absolute -right-24 -bottom-32 size-96 rounded-full bg-primary/10 blur-3xl" />
			</div>

			<div className="relative flex w-full max-w-xl flex-col overflow-hidden rounded-2xl border bg-card shadow-dialog">
				{/* Header: current step title + per-step action */}
				<div className="flex items-start justify-between gap-3 px-6 pt-5">
					<div className="min-w-0 max-w-md">
						{stepper.current.id === "welcome" ? null : (
							<>
								<span className="font-medium text-sm">{stepTitle}</span>
								{stepDesc ? (
									<p className="mt-1 text-muted-foreground text-xs leading-relaxed">
										{stepDesc}
									</p>
								) : null}
							</>
						)}
					</div>
					{stepper.current.id === "theme" ? (
						<ThemeModeSwitch
							value={settings.theme}
							onChange={(next) => patch({ theme: next })}
						/>
					) : null}
					{stepper.current.id === "agent" ? (
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => agentStepRef.current?.rescan()}
						>
							<RefreshCw data-icon="inline-start" />
							{t("agent.rescan")}
						</Button>
					) : null}
				</div>

				<div className="agentero-scroll max-h-[24rem] overflow-y-auto px-6 py-5">
					<AnimatePresence mode="wait" initial={false}>
						<motion.div
							key={stepper.current.id}
							initial={{ opacity: 0, y: 10 }}
							animate={{ opacity: 1, y: 0 }}
							exit={{ opacity: 0, y: -10 }}
							transition={{ duration: 0.16, ease: "easeOut" }}
						>
							{renderStep()}
						</motion.div>
					</AnimatePresence>
				</div>

				{/* Footer: back + progress + next */}
				<div className="relative flex items-center justify-between gap-3 border-t px-6 py-4">
					{stepper.isFirst ? (
						<div className="w-20" aria-hidden />
					) : (
						<Button
							type="button"
							variant="ghost"
							onClick={() => void stepper.prev()}
						>
							{t("actions.back")}
						</Button>
					)}
					{stepper.isFirst ? null : (
						<div className="absolute left-1/2 flex -translate-x-1/2 items-center">
							<FlowDots index={stepper.index} labels={stepLabels} />
						</div>
					)}
					<Button type="button" onClick={onNext}>
						{nextLabel}
						{stepper.isFirst ? <ArrowRight data-icon="inline-end" /> : null}
					</Button>
				</div>
			</div>
		</div>
	);
}

function ZoteroImportOfferDialog({
	open,
	onOpenChange,
	onImport,
	onLater,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onImport: () => void;
	onLater: () => void;
}) {
	const { t } = useTranslation("onboarding");
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent>
				<DialogHeader>
					<DialogTitle>{t("vault.zoteroOfferTitle")}</DialogTitle>
					<DialogDescription>{t("vault.zoteroOfferDesc")}</DialogDescription>
				</DialogHeader>
				<DialogFooter>
					<Button type="button" variant="ghost" onClick={onLater}>
						{t("vault.zoteroNo")}
					</Button>
					<Button type="button" onClick={onImport}>
						{t("vault.zotero")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
