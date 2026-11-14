/** Opt-in real PDF extraction/export validation. Inputs stay outside the repository. */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PdfiumNative } from "@embedpdf/engines/pdfium";
import { init } from "@embedpdf/pdfium";
import { describe, expect, it, vi } from "vitest";
import {
	listTranslatableLayoutRegions,
	toLayoutTranslateItems,
} from "@/lib/pdf/layout/layout-translate";
import { runLayoutRegionTranslate } from "@/lib/pdf/layout/layout-translate-reliable";
import type { PdfLayoutRegion } from "@/lib/pdf/layout/types";
import { buildReflowPage, buildReflowPdf } from "@/lib/pdf/reflow/export";
import { extractReflowDocument } from "@/lib/pdf/reflow/extract";
import { prepareReflowItems } from "@/lib/pdf/reflow/service";

// In full acceptance mode only the Host transport is replaced by a local HTTP
// adapter. The production batching, token validation and retries still execute.
vi.mock("@/lib/settings", () => ({
	loadSettings: () => ({
		translate: {
			provider: "tencenttransmart",
			sourceLang: "en",
			targetLang: "zh-CN",
			providerConfigs: {},
			agentId: "",
			modelId: "",
		},
	}),
}));
vi.mock("@/lib/translate", () => ({
	runTranslate: async ({ text }: { text: string }) => {
		const endpoint = process.env.AGENTERO_REFLOW_MT_ENDPOINT;
		if (!endpoint)
			throw new Error("Full acceptance requires AGENTERO_REFLOW_MT_ENDPOINT");
		const response = await fetch(endpoint, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ text }),
			signal: AbortSignal.timeout(90000),
		});
		const result = (await response.json()) as { text?: string; error?: string };
		if (!response.ok || !result.text)
			throw new Error(result.error ?? "Empty MT response");
		return result.text;
	},
}));

const dir = process.env.AGENTERO_REFLOW_FIXTURES,
	font = process.env.AGENTERO_REFLOW_FONT;
describe.skipIf(!dir || !font)("real PDF reflow", () => {
	it.each(
		(process.env.AGENTERO_REFLOW_PDFS ?? "attention,resnet").split(","),
	)("exports vector text and formulas in %s", async (name) => {
		const root = dir ?? "";
		const mode = process.env.AGENTERO_REFLOW_MODE ?? "fixed";
		const pages = (process.env.AGENTERO_REFLOW_PAGES ?? "1")
			.split(",")
			.map((n) => Number(n) - 1);
		const tag = mode === "fixed" ? name : `${name}-${mode}`;
		const engine = new PdfiumNative(
			await init({
				wasmBinary: readFileSync(
					fileURLToPath(import.meta.resolve("@embedpdf/pdfium/pdfium.wasm")),
				),
			}),
			{ fontFallback: null },
		);
		const bytes = readFileSync(join(root, `${name}.pdf`));
		const doc = await engine
			.openDocumentBuffer({
				id: name,
				content: bytes.buffer.slice(
					bytes.byteOffset,
					bytes.byteOffset + bytes.byteLength,
				),
			})
			.toPromise();
		try {
			const regions = (
				JSON.parse(readFileSync(join(root, `${name}-after.json`), "utf8"))
					.raw as PdfLayoutRegion[]
			).filter(
				(r) =>
					process.env.AGENTERO_REFLOW_PAGES === "all" ||
					pages.includes(r.pageIndex),
			);
			const items = toLayoutTranslateItems(
				listTranslatableLayoutRegions(regions),
			);
			const ir = await extractReflowDocument(engine, doc, items, regions);
			if (mode === "full") {
				for (const page of ir.pages) {
					expect(page.coverage?.length).toBeGreaterThan(0);
					const ids = page.paragraphs.flatMap((p) =>
						p.characters.map((c) => c.index),
					);
					expect(new Set(ids).size).toBe(ids.length);
					expect(
						page.paragraphs
							.flatMap((p) => p.characters)
							.every((c) => !c.text.trim() || c.textMatrix?.length === 6),
					).toBe(true);
				}
				if (name === "attention") {
					expect(
						ir.pages
							.find((p) => p.index === 12)
							?.paragraphs.map((p) => p.source.replace(/\s/g, "")),
					).toContain("AttentionVisualizations");
					expect(
						ir.pages
							.flatMap((p) => p.paragraphs)
							.some((p) => p.source.includes("Input Input Layer5")),
					).toBe(false);
				}
				if (name === "resnet")
					expect(
						ir.pages
							.find((p) => p.index === 1)
							?.paragraphs.some(
								(p) => p.origin === "fallback" && p.source === "weight layer",
							),
					).toBe(true);
			}

			writeFileSync(
				join(root, `${tag}-reflow-ir.json`),
				JSON.stringify(ir, null, 2),
			);
			const fixed =
				mode !== "fixed"
					? []
					: (JSON.parse(
							readFileSync(
								join(
									root,
									name === "attention"
										? "fixed-reference-input.json"
										: "resnet-reference-input.json",
								),
								"utf8",
							),
						) as { source: string; translated: string }[]);
			const translations = new Map<string, string>();
			if (mode === "full") {
				const prepared = await prepareReflowItems(engine, doc, items, regions);
				console.log(name, "prepared", prepared.length);
				const result = await runLayoutRegionTranslate({
					items: prepared,
					onUpdate: (items) =>
						writeFileSync(
							join(root, `${name}-full-status.json`),
							JSON.stringify(items),
						),
					concurrency: 2,
				});
				writeFileSync(
					join(root, `${name}-full-status.json`),
					JSON.stringify(result),
				);
				expect(
					result
						.filter((i) => i.status !== "done")
						.map((i) => ({ id: i.id, error: i.error })),
				).toEqual([]);
				expect(result.map((i) => i.id).sort()).toEqual(
					ir.pages.flatMap((p) => p.paragraphs.map((p) => p.id)).sort(),
				);
				for (const item of result)
					translations.set(item.id, item.translated ?? "");
			}
			const service =
				mode === "service"
					? (JSON.parse(
							readFileSync(
								join(root, `${name}-service-translations.json`),
								"utf8",
							),
						) as Record<string, string>)
					: {};
			for (const p of ir.pages.flatMap((p) => p.paragraphs)) {
				if (mode === "full") continue;
				if (mode !== "fixed") {
					const text = mode === "identity" ? p.protectedText : service[p.id];
					if (text) translations.set(p.id, text);
					continue;
				}
				const row = fixed.find((r) =>
					p.source
						.replace(/\s/g, "")
						.startsWith(r.source.replace(/\s/g, "").slice(0, 25)),
				);
				if (!row) continue;
				let text = row.translated;
				for (const f of p.formulas) {
					if (f.text === "8×") text = text.replace("8 倍", `⟪F${f.id}⟫`);
					else if (f.text === "×") text = text.replace("8 倍", `8⟪F${f.id}⟫`);
					else if (f.text === "1")
						text = text.replace("2015", `2015⟪F${f.id}⟫`);
					else if (text.includes(f.text))
						text = text.replace(f.text, `⟪F${f.id}⟫`);
					else
						throw new Error(`Unmapped formula ${JSON.stringify(f)} in ${p.id}`);
				}
				for (const id of Object.keys(p.styles)) {
					const content = new RegExp(`⟪S${id}⟫(.*?)⟪/S${id}⟫`)
						.exec(p.protectedText)?.[1]
						?.trim();
					const target = content === "test" ? "测试" : content;
					if (!target || !text.includes(target))
						throw new Error(`Unmapped style ${id}: ${content}`);
					text = text.replace(target, `⟪S${id}⟫${target}⟪/S${id}⟫`);
				}
				translations.set(p.id, text);
			}
			writeFileSync(
				join(root, `${tag}-reflow-ir.json`),
				JSON.stringify(ir, null, 2),
			);
			if (mode === "fixed")
				expect(translations.size).toBe(name === "attention" ? 3 : 4);
			else expect(translations.size).toBeGreaterThan(0);
			const fonts = {
				regular: readFileSync(
					join(dirname(font ?? ""), "NotoSerif-Regular.ttf"),
				),
				bold: readFileSync(join(dirname(font ?? ""), "NotoSerif-Bold.ttf")),
				italic: readFileSync(join(dirname(font ?? ""), "NotoSerif-Italic.ttf")),
				boldItalic: readFileSync(
					join(dirname(font ?? ""), "NotoSerif-BoldItalic.ttf"),
				),
				cjk: readFileSync(font ?? ""),
				cjkBold: readFileSync(
					join(dirname(font ?? ""), "SourceHanSerifCN-Bold.ttf"),
				),
			};
			const output = await buildReflowPdf(engine, doc, ir, translations, fonts);
			if (process.env.AGENTERO_REFLOW_INCREMENTAL === "1") {
				const pageIr = { ...ir, pages: [ir.pages[0]] };
				const start = performance.now();
				const single = await buildReflowPage(
					engine,
					doc,
					pageIr,
					translations,
					fonts,
				);
				const pageMs = Math.round(performance.now() - start);
				const fullStart = performance.now();
				const reference = await buildReflowPdf(
					engine,
					doc,
					pageIr,
					translations,
					fonts,
					undefined,
					false,
				);
				const timing = {
					name,
					page: pageIr.pages[0].index,
					pageMs,
					documentMs: Math.round(performance.now() - fullStart),
				};
				writeFileSync(
					join(root, `${tag}-incremental-timing.json`),
					JSON.stringify(timing, null, 2),
				);
				expect(single.pages).toEqual(reference.pages);
				const preview = await engine
					.openDocumentBuffer({
						id: `${name}-single`,
						content: single.bytes.slice().buffer,
					})
					.toPromise();
				const baseline = await engine
					.openDocumentBuffer({
						id: `${name}-reference`,
						content: reference.bytes.slice().buffer,
					})
					.toPromise();
				try {
					expect(preview.pages).toHaveLength(1);
					const actual = await engine
						.renderPageRaw(preview, preview.pages[0], { scaleFactor: 1 })
						.toPromise();
					const expected = await engine
						.renderPageRaw(baseline, baseline.pages[pageIr.pages[0].index], {
							scaleFactor: 1,
						})
						.toPromise();
					expect(actual).toEqual(expected);
				} finally {
					await engine.closeDocument(preview).toPromise();
					await engine.closeDocument(baseline).toPromise();
				}
			}
			writeFileSync(join(root, `${tag}-reflow.pdf`), output.bytes);
			writeFileSync(
				join(root, `${tag}-reflow-layout.json`),
				JSON.stringify(output.pages, null, 2),
			);
			expect(
				output.pages.flatMap((p) => p.paragraphs).every((p) => p.fits),
			).toBe(true);
			const exported = await engine
				.openDocumentBuffer({
					id: `${name}-output`,
					content: output.bytes.slice().buffer,
				})
				.toPromise();
			if (mode === "full") {
				expect(exported.pages.length).toBe(doc.pages.length);
				for (const page of exported.pages) {
					const runs = await engine.getPageTextRuns(exported, page).toPromise();
					expect(runs.runs.map((r) => r.text).join("")).not.toMatch(
						/⟪|⟦|ZXQ[A-Z]+QXZ/u,
					);
				}
			}
			const text = await engine
				.getPageTextRuns(exported, exported.pages[0])
				.toPromise();
			const exportedText = text.runs.map((r) => r.text).join("");
			if (mode === "fixed") {
				expect(exportedText).toContain("摘要");
				expect(exportedText).not.toContain(
					name === "attention"
						? "Attention Is All You Need"
						: "Deep Residual Learning",
				);
			}
			await engine.closeDocument(exported).toPromise();
		} finally {
			await engine.closeDocument(doc).toPromise();
			await engine.destroy().toPromise();
		}
	}, 1800000);
});
