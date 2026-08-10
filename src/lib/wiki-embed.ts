import {
	type ResolvedLink,
	type WikiEmbedResponse,
	wikiFragmentSuffix,
} from "@/lib/wiki";

export const MAX_WIKI_EMBED_DEPTH = 4;

export type WikiEmbedResponseKind =
	| "ready"
	| "missing"
	| "ambiguous"
	| "invalidFragment"
	| "unsupported";

export function wikiEmbedKey(link: ResolvedLink): string {
	return `${link.targetPath ?? link.occurrence.targetRaw}${wikiFragmentSuffix(link.occurrence.fragment)}`;
}

export function wikiEmbedResponseKind(
	response: WikiEmbedResponse,
): WikiEmbedResponseKind {
	if (response.link.status !== "resolved") return response.link.status;
	if (
		response.contentKind === "markdown" &&
		typeof response.content === "string"
	) {
		return "ready";
	}
	return response.contentKind === "image" ||
		response.contentKind === "pdf" ||
		response.contentKind === "annotation"
		? "ready"
		: "unsupported";
}

export function wikiEmbedBoundary(
	ancestry: readonly string[],
	key: string,
	maxDepth = MAX_WIKI_EMBED_DEPTH,
): "ready" | "cycle" | "depth" {
	if (ancestry.includes(key)) return "cycle";
	if (ancestry.length >= maxDepth) return "depth";
	return "ready";
}
