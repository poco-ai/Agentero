/**
 * Resolve an online-only figure supplement to a publisher permalink (or direct
 * image URL) from the paper's DOI / landing URL.
 *
 * Hover preview suppresses the main-figure crop whenever a label carries
 * `supplement`; a URL here is optional. Only publishers with a stable
 * DOI/permalink → image mapping are wired — start with eLife and PLOS, and
 * grow one class at a time.
 */

export type SupplementPaperIdentity = {
	doi?: string | null;
	source_url?: string | null;
	html_url?: string | null;
};

/** PLOS journal slug keyed by the DOI's `journal.<code>` segment. */
const PLOS_JOURNAL_SLUGS: Record<string, string> = {
	pone: "plosone",
	pbio: "plosbiology",
	pmed: "plosmedicine",
	pgen: "plosgenetics",
	pcbi: "ploscompbiol",
	ppat: "plospathogens",
	pntd: "plosntds",
	pdig: "digitalhealth",
	pclm: "climate",
	pwat: "water",
	psys: "sustainability",
};

/** eLife article id from a `10.7554/eLife.<id>` DOI or elifesciences.org URL. */
export function elifeArticleId(
	identity: SupplementPaperIdentity,
): string | null {
	const fromDoi = identity.doi?.match(/^10\.7554\/e?life\.(\d+)/i)?.[1];
	if (fromDoi) return fromDoi;
	const landing = identity.source_url ?? identity.html_url ?? "";
	return landing.match(/elifesciences\.org\/articles\/(\d+)/i)?.[1] ?? null;
}

/**
 * PLOS article DOI (`10.1371/journal.<code>.…`) and journal slug, or null when
 * the identity is not a recognized PLOS journal.
 */
export function plosArticleIdentity(
	identity: SupplementPaperIdentity,
): { doi: string; journal: string } | null {
	const doi = identity.doi?.trim();
	if (!doi) return null;
	const match = doi.match(/^10\.1371\/journal\.([a-z]+)\.\S+/i);
	if (!match) return null;
	const code = (match[1] ?? "").toLowerCase();
	const journal = PLOS_JOURNAL_SLUGS[code];
	if (!journal) return null;
	return { doi, journal };
}

/** Zero-pad a PLOS figure / SI index (`1` → `001`). */
function plosIndex(n: number): string {
	return String(n).padStart(3, "0");
}

/**
 * eLife figure-supplement permalink. Parent figure must be ≥ 1 — standalone
 * "Fig. S1" labels are not eLife's `figNsM` form.
 */
function elifeSupplementUrl(
	articleId: string,
	figure: number,
	supplement: number,
): string | null {
	if (figure < 1 || supplement < 1) return null;
	return `https://elifesciences.org/articles/${articleId}/figures#fig${figure}s${supplement}`;
}

/**
 * PLOS supporting-information file permalink. Standalone "Fig. SN" / "S1 Fig"
 * labels use `figure === 0` and the S-index in `supplement`; parent+supplement
 * forms (rare at PLOS) still address `.s00N` by the supplement index.
 *
 * Do **not** use `/article/figure/image` for SI `.s00N` — that path 302s to
 * `article/file?type=large` and 404s. The working permalink is
 * `/article/file?id=<doi>.s00N&type=supplementary`, which 302s to the corpus
 * asset (JPEG/PNG/WebP, or TIFF/PDF). Link-preview classifies it as `image` so
 * the card loads it through agentero-web `<img>` (onLoad / onError); page JS
 * must not probe the redirect with `fetch(..., { redirect: "manual" })`.
 */
function plosSupplementUrl(
	article: { doi: string; journal: string },
	supplement: number,
): string | null {
	if (supplement < 1) return null;
	const id = `${article.doi}.s${plosIndex(supplement)}`;
	return `https://journals.plos.org/${article.journal}/article/file?id=${id}&type=supplementary`;
}

/**
 * Resolve a supplement hover target for the given paper identity, or null when
 * the publisher is unknown / the label shape does not match that publisher.
 */
export function resolveSupplementFigureUrl(
	identity: SupplementPaperIdentity,
	figure: number,
	supplement: number,
): string | null {
	const elifeId = elifeArticleId(identity);
	if (elifeId) return elifeSupplementUrl(elifeId, figure, supplement);

	const plos = plosArticleIdentity(identity);
	if (plos) return plosSupplementUrl(plos, supplement);

	return null;
}
