import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	classifyLinkPreview,
	isPlosSupplementaryFileUrl,
	linkPreviewKindFromContentType,
	linkPreviewKindFromRedirectLocation,
	plosSupplementaryPreviewLoadUrl,
	resolveLinkPreviewTarget,
} from "@/lib/pdf/link-preview";
import {
	elifeArticleId,
	plosArticleIdentity,
	resolveSupplementFigureUrl,
} from "@/lib/pdf/supplement-figure-url";

describe("resolveSupplementFigureUrl", () => {
	it("keeps the eLife figures permalink for parent+supplement labels", () => {
		expect(
			resolveSupplementFigureUrl({ doi: "10.7554/eLife.49020" }, 5, 1),
		).toBe("https://elifesciences.org/articles/49020/figures#fig5s1");
		expect(
			resolveSupplementFigureUrl(
				{
					doi: null,
					html_url: "https://elifesciences.org/articles/49020",
				},
				2,
				3,
			),
		).toBe("https://elifesciences.org/articles/49020/figures#fig2s3");
	});

	it("does not invent an eLife fig0sN URL for standalone Fig. S labels", () => {
		expect(
			resolveSupplementFigureUrl({ doi: "10.7554/eLife.49020" }, 0, 1),
		).toBeNull();
	});

	it("maps PLOS DOIs to the supplementary file permalink for S-figures", () => {
		expect(
			resolveSupplementFigureUrl({ doi: "10.1371/journal.pone.0222160" }, 0, 1),
		).toBe(
			"https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0222160.s001&type=supplementary",
		);
		expect(
			resolveSupplementFigureUrl({ doi: "10.1371/journal.pbio.3002000" }, 0, 2),
		).toBe(
			"https://journals.plos.org/plosbiology/article/file?id=10.1371/journal.pbio.3002000.s002&type=supplementary",
		);
		expect(
			resolveSupplementFigureUrl({ doi: "10.1371/journal.pone.0118771" }, 0, 1),
		).toBe(
			"https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0118771.s001&type=supplementary",
		);
	});

	it("returns null for publishers without a stable mapping", () => {
		expect(
			resolveSupplementFigureUrl({ doi: "10.1000/unknown.123" }, 1, 1),
		).toBeNull();
		expect(resolveSupplementFigureUrl({}, 1, 1)).toBeNull();
	});
});

describe("supplement paper identity helpers", () => {
	it("reads eLife article ids from DOI or landing URL", () => {
		expect(elifeArticleId({ doi: "10.7554/eLife.49020" })).toBe("49020");
		expect(
			elifeArticleId({
				source_url: "https://elifesciences.org/articles/49020",
			}),
		).toBe("49020");
		expect(elifeArticleId({ doi: "10.1371/journal.pone.1" })).toBeNull();
	});

	it("maps PLOS journal codes to site slugs", () => {
		expect(
			plosArticleIdentity({ doi: "10.1371/journal.pone.0222160" }),
		).toEqual({
			doi: "10.1371/journal.pone.0222160",
			journal: "plosone",
		});
		expect(plosArticleIdentity({ doi: "10.1371/journal.zz.1" })).toBeNull();
	});
});

describe("link preview publisher figure images", () => {
	it("still resolves eLife figure permalinks to the CDN JPG", () => {
		expect(
			resolveLinkPreviewTarget(
				"https://elifesciences.org/articles/49020/figures#fig5s1",
			),
		).toEqual({
			kind: "image",
			url: "https://cdn.elifesciences.org/articles/49020/elife-49020-fig5-figsupp1-v1.jpg",
		});
	});

	it("keeps PLOS main-figure image endpoints as images", () => {
		const url =
			"https://journals.plos.org/plosone/article/figure/image?size=large&id=10.1371/journal.pone.0198243.g001";
		expect(classifyLinkPreview(url)).toBe("image");
		expect(resolveLinkPreviewTarget(url)).toEqual({ kind: "image", url });
	});

	it("classifies PLOS SI file permalinks as image for the proxy <img> path", () => {
		const jpegSi =
			"https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0118771.s001&type=supplementary";
		const tiffSi =
			"https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0222160.s001&type=supplementary";
		expect(isPlosSupplementaryFileUrl(jpegSi)).toBe(true);
		expect(classifyLinkPreview(jpegSi)).toBe("image");
		expect(resolveLinkPreviewTarget(jpegSi)).toEqual({
			kind: "image",
			url: jpegSi,
		});
		expect(classifyLinkPreview(tiffSi)).toBe("image");
		expect(resolveLinkPreviewTarget(tiffSi)).toEqual({
			kind: "image",
			url: tiffSi,
		});
	});

	it("JPEG SI preview loads the Host-resolved corpus URL, not the journals permalink alone", () => {
		// Live PLOS SI 302s to corpus-prod.…r2.cloudflarestorage.com. The proxy
		// only follows redirects when that hop is allowlisted; classifying the
		// permalink as `image` is not enough. Host resolve must return the
		// Location URL and the card must load that host through the proxy.
		const permalink =
			"https://journals.plos.org/plosone/article/file?id=10.1371/journal.pone.0118771.s001&type=supplementary";
		const corpus =
			"https://corpus-prod.f505aadad1e46610c8f8563037eb3c4b.r2.cloudflarestorage.com/10.1371/journal.pone.0118771/1/pone.0118771.s001.jpg?X-Amz-Signature=1";
		expect(plosSupplementaryPreviewLoadUrl(permalink, { url: corpus })).toBe(
			corpus,
		);
		expect(new URL(corpus).hostname).toMatch(/r2\.cloudflarestorage\.com$/);
		expect(plosSupplementaryPreviewLoadUrl(permalink, null)).toBeNull();
		expect(plosSupplementaryPreviewLoadUrl(permalink, undefined)).toBeNull();
		// TIFF / PDF Location must not reach <img> even if a caller passes it.
		expect(
			plosSupplementaryPreviewLoadUrl(permalink, {
				url: "https://corpus-prod.f505aadad1e46610c8f8563037eb3c4b.r2.cloudflarestorage.com/pone.0222160.s001.tif?X-Amz-Signature=1",
			}),
		).toBeNull();
		expect(
			plosSupplementaryPreviewLoadUrl(permalink, {
				url: "https://corpus-prod.example.r2.cloudflarestorage.com/pone.0222160.s001.pdf",
			}),
		).toBeNull();
		// Non-SI URLs stay out of this helper.
		expect(
			plosSupplementaryPreviewLoadUrl(
				"https://cdn.elifesciences.org/articles/49020/elife-49020-fig5-figsupp1-v1.jpg",
				{ url: corpus },
			),
		).toBeNull();
	});

	it("does not treat PLOS figure/image SI ids as images", () => {
		const url =
			"https://journals.plos.org/plosone/article/figure/image?size=large&id=10.1371/journal.pone.0222160.s001";
		expect(classifyLinkPreview(url)).not.toBe("image");
		expect(resolveLinkPreviewTarget(url).kind).not.toBe("image");
	});

	it("Host/proxy helpers only upgrade inline-decodable redirect / content types", () => {
		// These helpers are for Host/Rust/agentero-web probes — not page fetch.
		expect(
			linkPreviewKindFromRedirectLocation(
				"https://corpus.example/pone.0118771.s001.jpg?X-Amz-Signature=1",
			),
		).toBe("image");
		expect(
			linkPreviewKindFromRedirectLocation(
				"https://corpus.example/pone.0222160.s001.tif?X-Amz-Signature=1",
			),
		).toBe("none");
		expect(
			linkPreviewKindFromRedirectLocation(
				"https://corpus.example/pone.0222160.s001.pdf",
			),
		).toBe("none");
		expect(linkPreviewKindFromContentType("image/jpeg")).toBe("image");
		expect(linkPreviewKindFromContentType("image/png; charset=binary")).toBe(
			"image",
		);
		expect(linkPreviewKindFromContentType("image/webp")).toBe("image");
		expect(linkPreviewKindFromContentType("image/tiff")).toBe("none");
		expect(linkPreviewKindFromContentType("application/pdf")).toBe("none");
	});
});

describe("PLOS SI card path avoids opaque browser redirect probing", () => {
	it("Host-resolves PLOS SI and loads the corpus URL via proxy, without page fetch", () => {
		// Chromium/WebView from the app origin cannot read PLOS Location headers
		// (no CORS; opaque-redirect status 0). The card must Host-resolve the SI
		// permalink, allowlist the corpus host, and point <img> at that URL —
		// not merely classifyLinkPreview === "image" on the journals permalink.
		const cardPath = fileURLToPath(
			new URL(
				"../src/components/viewer/pdf/cards/link-preview-card.tsx",
				import.meta.url,
			),
		);
		const source = readFileSync(cardPath, "utf8");
		// Strip comments so doc warnings do not trip the guard.
		const code = source
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "");
		expect(code).not.toMatch(/fetch\s*\(/);
		expect(code).not.toMatch(/redirect\s*:\s*["']manual["']/);
		expect(source).toMatch(/webViewProxyUrl/);
		expect(source).toMatch(/webProxyAllowHost/);
		expect(code).toMatch(/webProxyResolveImage/);
		expect(code).toMatch(/isPlosSupplementaryFileUrl/);
		expect(code).toMatch(/plosSupplementaryPreviewLoadUrl/);
	});
});
