/**
 * Layout provider registry. Adding a provider means: extend the id union in
 * `settings.ts`, add one descriptor here, and register a Rust engine.
 */

import type { LayoutSidecarMode } from "@/lib/pdf/layout/io";
import type {
	LayoutBackend,
	LayoutProviderConfig,
	LayoutProviderId,
	ParserBackend,
} from "@/lib/pdf/layout/settings";

export type LayoutProviderDescriptor = {
	id: LayoutProviderId | "local";
	kind: "local" | "remote";
	requiresApiKey: boolean;
	supportsBaseUrl: boolean;
	/** Document language is user-selectable (MinerU only). */
	supportsLanguage?: boolean;
	/** Force-OCR toggle is available (MinerU only). */
	supportsOcr?: boolean;
	/** Self-hosted MinerU options: parse tier and 3.x legacy parameters. */
	supportsSelfHosted?: boolean;
	/** `source.mode` written to the layout sidecar for this provider's runs. */
	sidecarMode: LayoutSidecarMode;
};

export type RemoteLayoutProviderDescriptor = LayoutProviderDescriptor & {
	id: Exclude<LayoutBackend, "local">;
	kind: "remote";
};

/** Credential-card shape shared by the layout and body-parser provider UIs. */
export type ProviderCardDescriptor = {
	id: LayoutProviderId;
	requiresApiKey: boolean;
	supportsBaseUrl: boolean;
	/** Model id is user-selectable (body-parse engines only). */
	supportsModel?: boolean;
	/** OCR prompt is user-overridable (VLM engines only). */
	supportsPrompt?: boolean;
	/** Document language is user-selectable (MinerU only). */
	supportsLanguage?: boolean;
	/** Force-OCR toggle is available (MinerU only). */
	supportsOcr?: boolean;
	/** Self-hosted MinerU options: parse tier and 3.x legacy parameters. */
	supportsSelfHosted?: boolean;
};

export const LAYOUT_PROVIDERS: Record<LayoutBackend, LayoutProviderDescriptor> =
	{
		local: {
			id: "local",
			kind: "local",
			requiresApiKey: false,
			supportsBaseUrl: false,
			sidecarMode: "embedpdf-layout",
		},
		paddle: {
			id: "paddle",
			kind: "remote",
			requiresApiKey: true,
			supportsBaseUrl: false,
			sidecarMode: "paddle-layout",
		},
		mineru: {
			id: "mineru",
			kind: "remote",
			requiresApiKey: true,
			supportsBaseUrl: true,
			supportsLanguage: true,
			supportsOcr: true,
			supportsSelfHosted: true,
			sidecarMode: "mineru-layout",
		},
	};

export function layoutProviderFor(
	backend: string,
): LayoutProviderDescriptor | null {
	return (
		(LAYOUT_PROVIDERS as Record<string, LayoutProviderDescriptor>)[backend] ??
		null
	);
}

/** PAPER.md body-parser provider cards (`local` needs no credentials). */
export const PARSER_PROVIDERS: Record<
	ParserBackend,
	ProviderCardDescriptor | null
> = {
	local: null,
	// Built-in parser: the Host injects its compiled-in credential, so the card
	// exposes no fields (and is dropped by `isProviderCardConfigurable`).
	agentero: {
		id: "agentero",
		requiresApiKey: false,
		supportsBaseUrl: false,
		supportsModel: false,
		supportsPrompt: false,
		supportsLanguage: false,
		supportsOcr: false,
	},
	paddle: {
		id: "paddle",
		requiresApiKey: true,
		supportsBaseUrl: false,
		supportsModel: true,
	},
	mineru: {
		id: "mineru",
		requiresApiKey: true,
		supportsBaseUrl: true,
		supportsLanguage: true,
		supportsOcr: true,
		supportsSelfHosted: true,
	},
	openaiCompatible: {
		id: "openaiCompatible",
		requiresApiKey: true,
		supportsBaseUrl: true,
		supportsModel: true,
		supportsPrompt: true,
	},
};

/** True when a card has at least one user-editable field (else render nothing). */
export function isProviderCardConfigurable(
	card: ProviderCardDescriptor,
): boolean {
	return (
		card.requiresApiKey ||
		card.supportsBaseUrl ||
		card.supportsModel === true ||
		card.supportsPrompt === true ||
		card.supportsLanguage === true ||
		card.supportsOcr === true
	);
}

/** A layout backend rendered as a credential card (no model / prompt). */
export function layoutProviderCard(
	descriptor: LayoutProviderDescriptor,
): ProviderCardDescriptor | null {
	if (!isRemoteLayoutProvider(descriptor)) return null;
	return {
		id: descriptor.id,
		requiresApiKey: descriptor.requiresApiKey,
		supportsBaseUrl: descriptor.supportsBaseUrl,
		supportsLanguage: descriptor.supportsLanguage,
		supportsOcr: descriptor.supportsOcr,
		supportsSelfHosted: descriptor.supportsSelfHosted,
	};
}

/**
 * One card per provider, unioning the fields each role needs. The layout and
 * body-parse engines can point at the same provider, and that single card must
 * still expose the model / prompt inputs the parser role requires.
 */
export function mergeProviderCards(
	cards: readonly (ProviderCardDescriptor | null)[],
): ProviderCardDescriptor[] {
	const merged = new Map<LayoutProviderId, ProviderCardDescriptor>();
	for (const card of cards) {
		if (!card) continue;
		const previous = merged.get(card.id);
		merged.set(
			card.id,
			previous
				? {
						id: card.id,
						requiresApiKey: previous.requiresApiKey || card.requiresApiKey,
						supportsBaseUrl: previous.supportsBaseUrl || card.supportsBaseUrl,
						supportsModel: previous.supportsModel || card.supportsModel,
						supportsPrompt: previous.supportsPrompt || card.supportsPrompt,
						supportsLanguage:
							previous.supportsLanguage || card.supportsLanguage,
						supportsOcr: previous.supportsOcr || card.supportsOcr,
						supportsSelfHosted:
							previous.supportsSelfHosted || card.supportsSelfHosted,
					}
				: card,
		);
	}
	return [...merged.values()];
}

export function isRemoteLayoutProvider(
	descriptor: LayoutProviderDescriptor,
): descriptor is RemoteLayoutProviderDescriptor {
	return descriptor.kind === "remote";
}

/**
 * A provider card is usable when it has a credential, or — for providers that
 * support it — when it points at a self-hosted endpoint, which may run
 * anonymously. This gates the backend selects and the connectivity probe, so a
 * keyless self-hosted MinerU can be configured like any other provider; the
 * cloud providers keep requiring a key.
 */
export function isProviderReady(
	card: Pick<ProviderCardDescriptor, "supportsSelfHosted">,
	config: Pick<LayoutProviderConfig, "apiKey" | "baseUrl" | "selfHosted">,
): boolean {
	if (config.apiKey.trim().length > 0) return true;
	if (!card.supportsSelfHosted || !config.selfHosted) return false;
	return config.baseUrl.trim().length > 0;
}

/**
 * True when at least one card can be used. Drives the "configure a provider
 * first" hint: while every card is unusable the backend menus list nothing but
 * the on-device engines, which otherwise reads as "this app cannot do MinerU".
 */
export function hasReadyProvider(
	cards: readonly ProviderCardDescriptor[],
	configs: Partial<Record<LayoutProviderId, LayoutProviderConfig>>,
): boolean {
	return cards.some((card) => {
		const config = configs[card.id];
		return Boolean(config && isProviderReady(card, config));
	});
}
