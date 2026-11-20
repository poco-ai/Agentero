import { z } from "zod";

const API_URL = "https://huggingface.co/api/daily_papers";
const dailyPaper = z.object({
	thumbnail: z.unknown().optional(),
	paper: z.object({
		id: z.string().regex(/^\d{4}\.\d{4,5}(?:v\d+)?$/),
		title: z.string().trim().min(1),
		summary: z.string().trim().nullish(),
		authors: z
			.array(z.object({ name: z.string(), hidden: z.boolean().optional() }))
			.optional(),
		upvotes: z.number().int().nonnegative().optional(),
		submittedOnDailyAt: z.string().nullish(),
	}),
});

export type HuggingFacePaper = {
	arxivId: string;
	title: string;
	abstract: string;
	authors: string[];
	upvotes?: number;
	edition: string | null;
	thumbnail: string | null;
};

function paperThumbnail(value: unknown): string | null {
	if (typeof value !== "string") return null;
	try {
		const url = new URL(value);
		// Load covers only from the official thumbnail CDN.
		return url.origin === "https://cdn-thumbnails.huggingface.co" &&
			!url.username &&
			!url.password
			? url.href
			: null;
	} catch {
		return null;
	}
}

export async function loadHuggingFacePapers(
	date: string,
	signal: AbortSignal,
): Promise<HuggingFacePaper[]> {
	const url = new URL(API_URL);
	if (date) url.searchParams.set("date", date);
	const response = await fetch(url, { signal });
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const payload = z.array(z.unknown()).parse(await response.json());
	const papers = new Map<string, HuggingFacePaper>();
	for (const row of payload) {
		const parsed = dailyPaper.safeParse(row);
		if (!parsed.success) continue;
		const { paper } = parsed.data;
		const arxivId = paper.id.replace(/v\d+$/, "");
		if (papers.has(arxivId)) continue;
		papers.set(arxivId, {
			arxivId,
			title: paper.title,
			thumbnail: paperThumbnail(parsed.data.thumbnail),
			abstract: paper.summary ?? "",
			authors: (paper.authors ?? [])
				.filter((author) => !author.hidden)
				.map((author) => author.name),
			upvotes: paper.upvotes,
			edition:
				paper.submittedOnDailyAt?.match(/^\d{4}-\d{2}-\d{2}(?=T|$)/)?.[0] ??
				null,
		});
	}
	if (payload.length > 0 && papers.size === 0) {
		throw new Error("Unexpected Hugging Face Daily Papers response");
	}
	return [...papers.values()];
}
