/**
 * Shared save/probe logic for the layout provider config UIs
 * (Settings → Layout pane and the onboarding layout step).
 */

import { errorMessage } from "@/lib/core/notify";
import { isSecretMask, maskSecret } from "@/lib/core/secret-mask";
import { isTauri } from "@/lib/core/tauri";
import {
	invokeLayoutRemoteProbe,
	tinyProbeJpegBase64,
} from "@/lib/pdf/layout/paddle";
import {
	isLayoutBackend,
	isParserBackend,
	type LayoutBackend,
	type LayoutProviderConfig,
	type LayoutProviderId,
	type LayoutSettings,
	type ParserBackend,
} from "@/lib/pdf/layout/settings";
import type { AppSettings } from "@/lib/settings";
import { saveSettingsAsync } from "@/lib/settings";

/**
 * When clearing a provider key, fall active backends back to local if they
 * still point at that provider (so Settings selects drop the option).
 */
export function layoutBackendsAfterClearingProvider(
	layout: LayoutSettings,
	provider: LayoutProviderId,
): Pick<LayoutSettings, "backend" | "parserBackend"> {
	return {
		backend:
			isLayoutBackend(provider) && layout.backend === provider
				? "local"
				: layout.backend,
		parserBackend:
			isParserBackend(provider) && layout.parserBackend === provider
				? "local"
				: layout.parserBackend,
	};
}

/**
 * Persist one provider config (plaintext key goes to the Host, which keeps
 * the secret) and return the masked layout snapshot for in-memory UI state.
 *
 * An empty `config.apiKey` clears the stored secret (Host merge only preserves
 * when the UI sends a `*` mask) and falls `backend` / `parserBackend` back to
 * `local` when they pointed at this provider, unless the caller overrides them
 * or `ready` says the card is still usable without a key (a self-hosted
 * endpoint, see `isProviderReady`).
 */
export async function persistLayoutProviderConfig(opts: {
	settings: AppSettings;
	provider: LayoutProviderId;
	config: LayoutProviderConfig;
	/** Card is usable without an apiKey (self-hosted endpoint). */
	ready?: boolean;
	/** Also switch the active layout backend (onboarding / explicit override). */
	backend?: LayoutBackend;
	/** Also switch the body-parse engine (explicit override). */
	parserBackend?: ParserBackend;
}): Promise<{ displayLayout: LayoutSettings }> {
	const layout = opts.settings.layout;
	const ready = opts.ready ?? opts.config.apiKey.trim().length > 0;
	const clearing = !ready;
	const clearedBackends = clearing
		? layoutBackendsAfterClearingProvider(layout, opts.provider)
		: null;
	const savedLayout: LayoutSettings = {
		...layout,
		backend: opts.backend ?? clearedBackends?.backend ?? layout.backend,
		parserBackend:
			opts.parserBackend ??
			clearedBackends?.parserBackend ??
			layout.parserBackend,
		providerConfigs: {
			...layout.providerConfigs,
			[opts.provider]: opts.config,
		},
	};
	try {
		await saveSettingsAsync({ ...opts.settings, layout: savedLayout });
	} catch {
		// Still mask the UI below.
	}
	const masked = isSecretMask(opts.config.apiKey)
		? opts.config.apiKey
		: maskSecret(opts.config.apiKey);
	return {
		displayLayout: {
			...savedLayout,
			providerConfigs: {
				...savedLayout.providerConfigs,
				[opts.provider]: { ...opts.config, apiKey: masked },
			},
		},
	};
}

/** Outcome of one connectivity probe. `error` is the Host's message, if any. */
export type LayoutProbeOutcome = { ok: boolean; error?: string };

/**
 * One-shot connectivity probe through the Host. A masked key is resolved
 * from stored settings; the base URL and the self-hosted flag always come
 * from stored settings, so persist before probing.
 */
export async function probeLayoutProvider(
	provider: LayoutProviderId,
	apiKey: string,
): Promise<LayoutProbeOutcome> {
	if (!isTauri()) return { ok: false };
	const base64 = tinyProbeJpegBase64();
	if (!base64) return { ok: false, error: "probe image unavailable" };
	try {
		await invokeLayoutRemoteProbe({
			provider,
			imageBase64: base64,
			apiKey: apiKey.trim() || undefined,
		});
		return { ok: true };
	} catch (err) {
		return { ok: false, error: errorMessage(err) };
	}
}
