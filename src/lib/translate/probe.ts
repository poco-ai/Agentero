/**
 * Availability probes for free MT and commercial BYOK providers (excludes Agent).
 * Used by Settings → Translate when the default-service Select opens or on Confirm.
 */

import {
	BUILTIN_PROVIDER_ID,
	loadBuiltinProviderStatus,
} from "@/lib/core/builtin";
import { hasSecret, isSecretMask } from "@/lib/core/secret-mask";
import { isTauri } from "@/lib/core/tauri";
import { invokeTranslateText } from "@/lib/translate/api";
import type {
	CommercialTranslateProviderId,
	FreeTranslateProviderId,
	TranslateProviderConfig,
} from "@/lib/translate/types";
import { FREE_MT_PROVIDER_IDS } from "@/lib/translate/types";
import type { ProbeStatus } from "@/lib/ui/probe-status";

/** Short probe sample: en → zh-CN, minimal payload. */
const PROBE_TEXT = "Hi";
const PROBE_SOURCE = "en";
const PROBE_TARGET = "zh-CN";

/** Host timeout for each probe request (ms). */
export const TRANSLATE_PROBE_TIMEOUT_MS = 5_000;

export type FreeMtProbeStatus = ProbeStatus;

export type FreeMtProbeMap = Partial<
	Record<FreeTranslateProviderId, FreeMtProbeStatus>
>;

export type CommercialMtProbeMap = Partial<
	Record<CommercialTranslateProviderId, FreeMtProbeStatus>
>;

export type ProbeFreeMtOptions = {
	/** Per-request timeout; default {@link TRANSLATE_PROBE_TIMEOUT_MS}. */
	timeoutMs?: number;
	/** Called as each provider finishes (progressive UI). */
	onResult?: (id: FreeTranslateProviderId, ok: boolean) => void;
	/**
	 * Optional abort: when aborted, remaining probes still resolve as fail
	 * (Tauri invoke cannot cancel in-flight host work).
	 */
	signal?: AbortSignal;
};

export type ProbeCommercialMtOptions = {
	config: TranslateProviderConfig;
	/** Per-request timeout; default {@link TRANSLATE_PROBE_TIMEOUT_MS}. */
	timeoutMs?: number;
	signal?: AbortSignal;
};

export function isCommercialProviderConfigured(
	id: CommercialTranslateProviderId,
	config: TranslateProviderConfig | undefined,
): boolean {
	if (!hasSecret(config?.apiKey)) return false;
	if (id === "azure" && !config?.region.trim()) return false;
	if (id === "openaiCompatible" && !config?.model.trim()) return false;
	return true;
}

async function probeOne(
	id: FreeTranslateProviderId,
	opts: ProbeFreeMtOptions,
): Promise<boolean> {
	if (opts.signal?.aborted) return false;
	if (!isTauri()) return false;
	try {
		const text = await invokeTranslateText({
			text: PROBE_TEXT,
			sourceLang: PROBE_SOURCE,
			targetLang: PROBE_TARGET,
			provider: id,
			timeoutMs: opts.timeoutMs ?? TRANSLATE_PROBE_TIMEOUT_MS,
		});
		return text.trim().length > 0;
	} catch {
		return false;
	}
}

/**
 * Probe all free MT engines in parallel, the built-in included (its probe
 * fires one real "Hi" translation through the Host-injected credential).
 * Results stream via `onResult`; returned map is the final snapshot.
 *
 * The built-in resolves to `false` without a request when
 * `builtinProviderStatus` says it is unavailable — probing then would only
 * re-report the deterministic no-key failure.
 */
export async function probeFreeMtProviders(
	opts: ProbeFreeMtOptions = {},
): Promise<Record<FreeTranslateProviderId, boolean>> {
	const builtinReady = (await loadBuiltinProviderStatus())?.available ?? false;
	const results = await Promise.all(
		FREE_MT_PROVIDER_IDS.map(async (id) => {
			const ok =
				id === BUILTIN_PROVIDER_ID && !builtinReady
					? false
					: await probeOne(id, opts);
			opts.onResult?.(id, ok);
			return [id, ok] as const;
		}),
	);
	const map = {} as Record<FreeTranslateProviderId, boolean>;
	for (const [id, ok] of results) {
		map[id] = ok;
	}
	return map;
}

export async function probeCommercialMtProvider(
	id: CommercialTranslateProviderId,
	opts: ProbeCommercialMtOptions,
): Promise<boolean> {
	if (opts.signal?.aborted) return false;
	if (!isCommercialProviderConfigured(id, opts.config)) return false;
	if (!isTauri()) return false;
	const rawKey = opts.config.apiKey.trim();
	try {
		const text = await invokeTranslateText({
			text: PROBE_TEXT,
			sourceLang: PROBE_SOURCE,
			targetLang: PROBE_TARGET,
			provider: id,
			// Mask → Host resolves from durable settings; real draft key is sent once.
			apiKey: rawKey && !isSecretMask(rawKey) ? rawKey : undefined,
			baseUrl: opts.config.baseUrl,
			region: opts.config.region,
			model: opts.config.model,
			extraRequestBody: opts.config.extraRequestBody,
			timeoutMs: opts.timeoutMs ?? TRANSLATE_PROBE_TIMEOUT_MS,
		});
		return text.trim().length > 0;
	} catch {
		return false;
	}
}
