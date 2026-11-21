import { createStore } from "zustand/vanilla";

type OnboardingState = {
	/** Reopen the wizard on demand (e.g. from Settings), even after completion. */
	forceOpen: boolean;
	/** Whether the wizard overlay is currently visible. */
	open: boolean;
	/** Covers directory creation and the post-create import choice, even after the wizard closes. */
	vaultSetupPending: boolean;
};

export const onboardingStore = createStore<OnboardingState>(() => ({
	forceOpen: false,
	open: false,
	vaultSetupPending: false,
}));

/** Open the wizard (fresh install auto-show, or Settings replay). */
export function requestOnboarding(): void {
	onboardingStore.setState({ forceOpen: true, open: true });
}

/** Wizard step finished / vault activated — close the overlay. */
export function closeOnboarding(): void {
	onboardingStore.setState({ forceOpen: false, open: false });
}
