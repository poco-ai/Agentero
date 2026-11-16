import { accountSurfaceEnabled } from "@/features/account/visibility";
import { AgentTranslateService } from "@/lib/translate/services/agent";
import { makeCommercialMtService } from "@/lib/translate/services/commercial";
import { makeFreeMtService } from "@/lib/translate/services/free";
import type {
	CommercialTranslateProviderId,
	FreeTranslateProviderId,
	TranslateProviderId,
	TranslateService,
} from "@/lib/translate/types";
import {
	COMMERCIAL_MT_PROVIDER_IDS,
	FREE_MT_PROVIDER_IDS,
} from "@/lib/translate/types";

/**
 * Free web engines + BYOA Agent (no paid APIs).
 * Derived from FREE_MT_PROVIDER_IDS — the single ordered provider list.
 */
export const TRANSLATE_SERVICES: TranslateService[] = [
	...FREE_MT_PROVIDER_IDS.map(makeFreeMtService),
	...COMMERCIAL_MT_PROVIDER_IDS.map(makeCommercialMtService),
	AgentTranslateService,
];

export function getTranslateService(id: string): TranslateService | undefined {
	return TRANSLATE_SERVICES.find((s) => s.id === id);
}

export function isTranslateProviderId(id: string): id is TranslateProviderId {
	if (id === "agent") return true;
	return (
		(FREE_MT_PROVIDER_IDS as string[]).includes(id) ||
		(COMMERCIAL_MT_PROVIDER_IDS as string[]).includes(id)
	);
}

export function isCommercialTranslateProvider(
	id: string,
): id is CommercialTranslateProviderId {
	return (COMMERCIAL_MT_PROVIDER_IDS as string[]).includes(id);
}

export function isFreeMtProvider(id: string): id is FreeTranslateProviderId {
	return (FREE_MT_PROVIDER_IDS as string[]).includes(id);
}

/** Providers shown in Settings Select. */
export function listSelectableProviders(): TranslateService[] {
	return TRANSLATE_SERVICES.filter(
		(service) => service.id !== "agentero" || accountSurfaceEnabled,
	);
}
