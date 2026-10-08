/**
 * App bootstrap effects: theme / locale / uiScale application, restored-vault
 * validation then `app:ready`, lifecycle handler registration + wire bridge
 * (per-vault side effects run via the `vault:opened` scope), and the JobCenter
 * executor subscriptions. Store seeding happens in `boot()` before first paint.
 */

import { useTheme } from "next-themes";
import { useEffect } from "react";
import { useSettings, useVaultStore } from "@/hooks/use-app-stores";
import { useUiRequest } from "@/hooks/use-ui-request";
import { useVaultOpenRequest } from "@/hooks/use-vault-open-request";
import { applyLocale } from "@/i18n";
import { startActivityTracking } from "@/lib/activity";
import { commands } from "@/lib/core/bindings";
import { startTaskRuntime } from "@/lib/core/tasks";
import { isTauri } from "@/lib/core/tauri";
import { initLifecycleBridge, lifecycle } from "@/lib/lifecycle";
import { registerLifecycleHandlers } from "@/lib/lifecycle/register";
import {
	registerConnectorTaskExecutor,
	startConnectorProgressRelay,
} from "@/lib/paper/import/connector-tasks";
import { registerImportTaskExecutor } from "@/lib/paper/import/import-tasks";
import { startJobCompletionRefresh } from "@/lib/paper/job-refresh";
import { refreshLibrary } from "@/lib/paper/library-store";
import { registerLibraryTaskExecutors } from "@/lib/paper/library-tasks";
// Side-effect: register catalog title lookup for JobCenter task subjects.
import "@/lib/paper/task-label";
import { registerLayoutTaskExecutor } from "@/lib/pdf/layout/enqueue-paper-layout";
import { applyDocumentChrome } from "@/lib/settings";
import { validateRestoredVault } from "@/lib/vault/actions";
import { setTree, setTreeLoading } from "@/lib/vault/store";

export function useAppBootstrap(): void {
	const { setTheme } = useTheme();
	// CLI / deep-link: agentero open <path> → vault:open-request
	useVaultOpenRequest();
	// CLI / deep-link: agentero paper open / agentero ui … → ui:request
	useUiRequest();

	const theme = useSettings((s) => s.theme);
	const locale = useSettings((s) => s.locale);
	const uiScale = useSettings((s) => s.uiScale);
	const interfaceFontFamily = useSettings((s) => s.interfaceFontFamily);
	const monoFontFamily = useSettings((s) => s.monoFontFamily);
	const vaultPath = useVaultStore((s) => s.vaultPath);

	useEffect(() => {
		setTheme(theme);
	}, [theme, setTheme]);

	useEffect(() => {
		const resolved = applyLocale(locale);
		if (!isTauri()) return;
		void (async () => {
			try {
				await commands.setLocale(resolved);
			} catch {
				// Native menu keeps its previous locale; non-fatal.
			}
		})();
	}, [locale]);

	useEffect(() => {
		// Scale + interface/mono fonts. macOS traffic lights stay build-time only.
		applyDocumentChrome({
			uiScale,
			interfaceFontFamily,
			monoFontFamily,
		});
	}, [uiScale, interfaceFontFamily, monoFontFamily]);

	useEffect(() => startActivityTracking(), []);

	// Validate the restored local Vault before restoring its tree and tabs, then
	// announce readiness — app:ready must not claim a validation that is still
	// in flight.
	useEffect(() => {
		let cancelled = false;
		void validateRestoredVault().then(() => {
			if (cancelled) return;
			void lifecycle.emit("app:ready", { timestamp: Date.now() });
		});
		return () => {
			cancelled = true;
		};
	}, []);

	// Register lifecycle handlers, then bridge Tauri wire events into the bus.
	useEffect(() => {
		const unregister = registerLifecycleHandlers();
		if (!isTauri()) return unregister;
		const dispose = initLifecycleBridge();
		return () => {
			dispose();
			unregister();
		};
	}, []);

	// Per-vault side effects hang off vault:opened (see lifecycle/register.ts).
	// Returning the scope release makes switch / close / unmount all tear down.
	useEffect(() => {
		if (!vaultPath) {
			setTree([]);
			setTreeLoading(false);
			void refreshLibrary();
			return;
		}
		return lifecycle.emitScoped("vault:opened", {
			vaultId: vaultPath,
			timestamp: Date.now(),
		});
	}, [vaultPath]);

	// Start listening for renderer-executed JobCenter offers.
	useEffect(() => {
		if (!isTauri()) return;
		registerLayoutTaskExecutor();
		registerImportTaskExecutor();
		registerConnectorTaskExecutor();
		registerLibraryTaskExecutors();
		const disposeRuntime = startTaskRuntime();
		const disposeConnector = startConnectorProgressRelay();
		const disposeRefresh = startJobCompletionRefresh();
		return () => {
			disposeRuntime();
			disposeConnector();
			disposeRefresh();
		};
	}, []);
}
