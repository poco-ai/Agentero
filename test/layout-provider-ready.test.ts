import { describe, expect, it } from "vitest";
import {
	hasReadyProvider,
	isProviderReady,
	LAYOUT_PROVIDERS,
	layoutProviderCard,
	type ProviderCardDescriptor,
} from "@/lib/pdf/layout/providers";
import {
	DEFAULT_MINERU_LANGUAGE,
	type LayoutProviderConfig,
} from "@/lib/pdf/layout/settings";

function cardFor(backend: "mineru" | "paddle"): ProviderCardDescriptor {
	const card = layoutProviderCard(LAYOUT_PROVIDERS[backend]);
	if (!card) throw new Error(`no configurable card for ${backend}`);
	return card;
}

function config(
	overrides: Partial<LayoutProviderConfig> = {},
): LayoutProviderConfig {
	return {
		apiKey: "",
		baseUrl: "",
		model: "",
		prompt: "",
		language: DEFAULT_MINERU_LANGUAGE,
		isOcr: false,
		selfHosted: false,
		...overrides,
	};
}

describe("isProviderReady", () => {
	it("requires an api key for a cloud-only provider", () => {
		const paddle = cardFor("paddle");
		expect(isProviderReady(paddle, config())).toBe(false);
		expect(isProviderReady(paddle, config({ apiKey: "sk-paddle" }))).toBe(true);
	});

	it("requires an api key for MinerU cloud", () => {
		const mineru = cardFor("mineru");
		expect(isProviderReady(mineru, config())).toBe(false);
		expect(isProviderReady(mineru, config({ apiKey: "sk-mineru" }))).toBe(true);
	});

	it("accepts a keyless self-hosted MinerU endpoint", () => {
		const mineru = cardFor("mineru");
		expect(
			isProviderReady(
				mineru,
				config({ selfHosted: true, baseUrl: "http://127.0.0.1:8012" }),
			),
		).toBe(true);
	});

	it("still needs a base URL for a keyless self-hosted MinerU", () => {
		const mineru = cardFor("mineru");
		expect(isProviderReady(mineru, config({ selfHosted: true }))).toBe(false);
		expect(
			isProviderReady(mineru, config({ selfHosted: true, baseUrl: "   " })),
		).toBe(false);
	});

	it("does not treat whitespace as a credential", () => {
		const mineru = cardFor("mineru");
		expect(isProviderReady(mineru, config({ apiKey: "   " }))).toBe(false);
	});

	it("ignores the self-hosted flag on providers without that option", () => {
		const paddle = cardFor("paddle");
		expect(
			isProviderReady(
				paddle,
				config({ selfHosted: true, baseUrl: "http://127.0.0.1:8012" }),
			),
		).toBe(false);
	});
});

describe("hasReadyProvider", () => {
	const cards = [cardFor("paddle"), cardFor("mineru")];

	it("is false while every card is unusable", () => {
		expect(hasReadyProvider(cards, {})).toBe(false);
		expect(
			hasReadyProvider(cards, {
				paddle: config(),
				mineru: config({ selfHosted: true }),
			}),
		).toBe(false);
	});

	it("turns true once any card is usable", () => {
		expect(
			hasReadyProvider(cards, { paddle: config({ apiKey: "sk-paddle" }) }),
		).toBe(true);
		expect(
			hasReadyProvider(cards, {
				mineru: config({ selfHosted: true, baseUrl: "http://127.0.0.1:8012" }),
			}),
		).toBe(true);
	});

	it("stays true when one provider is configured and another is not", () => {
		// The hint is a cold-start aid: once anything works, the menu already
		// explains itself, so the "Paddle ready, MinerU missing" case hides it.
		expect(
			hasReadyProvider(cards, {
				paddle: config({ apiKey: "sk-paddle" }),
				mineru: config(),
			}),
		).toBe(true);
	});
});
