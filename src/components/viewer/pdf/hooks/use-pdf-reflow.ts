import type { PdfDocumentObject, PdfEngine } from "@embedpdf/models";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/hooks/use-app-stores";
import { errorText } from "@/lib/core/error";
import { logOp } from "@/lib/core/logger";
import { notifyError } from "@/lib/core/notify";
import type {
	LayoutTranslateItem,
	PdfLayoutRegion,
} from "@/lib/pdf/layout/types";
import { createReflowBuildCache } from "@/lib/pdf/reflow/build-cache";
import { ReflowBuildEngine } from "@/lib/pdf/reflow/builder";
import { createReflowIrCache } from "@/lib/pdf/reflow/cache";
import { interleaveReflowPdf } from "@/lib/pdf/reflow/export";
import { loadReflowFonts } from "@/lib/pdf/reflow/fonts";
import { NO_REGIONS, ReflowPreviewSession } from "@/lib/pdf/reflow/preview";
import { prepareReflowItems } from "@/lib/pdf/reflow/service";
import { writeVaultBytes } from "@/lib/vault/fs";
export type ReflowContext = () => {
	engine: PdfEngine;
	document: PdfDocumentObject;
} | null;
export function usePdfReflow(
	context: ReflowContext | undefined,
	regions: PdfLayoutRegion[] | null,
	items: LayoutTranslateItem[],
	running: boolean,
	documentKey: string,
	paperAbsPath?: string | null,
	paperKey?: string | null,
	pdfBytes?: ArrayBuffer | null,
) {
	const { t } = useTranslation("viewer");
	// Cache persistence is user-controlled (Settings → Translate). The ref keeps
	// a running session in sync without rebuilding it when a switch flips.
	const cacheReflowIr = useSettings((s) => s.translate.cacheReflowIr);
	const cacheReflowFinal = useSettings((s) => s.translate.cacheReflowFinal);
	const cacheFlags = useRef({ ir: cacheReflowIr, final: cacheReflowFinal });
	cacheFlags.current = { ir: cacheReflowIr, final: cacheReflowFinal };
	const current = useRef({
		context,
		regions,
		items,
		running,
		paperAbsPath,
		paperKey,
		pdfBytes,
	});
	current.current = {
		context,
		regions,
		items,
		running,
		paperAbsPath,
		paperKey,
		pdfBytes,
	};
	const session = useRef<ReflowPreviewSession | null>(null);
	const [revision, setRevision] = useState(0);
	const ctx = context?.();
	const engine = ctx?.engine,
		document = ctx?.document;
	const prepare = useCallback(
		async (seed: LayoutTranslateItem[], signal?: AbortSignal) => {
			const value = session.current;
			const ctx = current.current.context?.();
			if (!ctx) return seed;
			const regions = current.current.regions ?? [];
			const cache = createReflowIrCache(
				{
					paperKey: current.current.paperKey || current.current.paperAbsPath,
					paperAbsPath: current.current.paperAbsPath,
					pdfBytes: current.current.pdfBytes,
					items: seed,
					regions,
				},
				{ writesEnabled: () => cacheFlags.current.ir },
			);
			if (value) return value.prepare(seed, regions, signal, cache);
			void loadReflowFonts().catch(() => {});
			return logOp("pdf.reflow.prepare", { items: seed.length }, () =>
				prepareReflowItems(
					ctx.engine,
					ctx.document,
					seed,
					regions,
					signal,
					cache,
				),
			);
		},
		[],
	);
	useEffect(() => {
		if (!engine || !document || !documentKey) return;
		// Reflow builds get their own PDFium engine (a private copy of the
		// document) so streaming previews never queue behind scroll rendering.
		const build = new ReflowBuildEngine({ engine, document });
		const value = new ReflowPreviewSession(
			engine,
			document,
			() => setRevision((n) => n + 1),
			(error) =>
				notifyError(t("pdf.layoutTranslate.reflowFailed"), {
					description: errorText(error),
				}),
			build,
			createReflowBuildCache(
				{
					paperKey: current.current.paperKey || current.current.paperAbsPath,
					pdfBytes: current.current.pdfBytes,
				},
				{ writesEnabled: () => cacheFlags.current.final },
			),
		);
		session.current = value;
		return () => {
			value.dispose();
			if (session.current === value) session.current = null;
		};
	}, [engine, document, documentKey, t]);
	// Re-run when the owning session is recreated, even if inputs are unchanged.
	// biome-ignore lint/correctness/useExhaustiveDependencies: session lifetime dependencies
	useEffect(() => {
		session.current?.update(items, regions ?? NO_REGIONS, running);
	}, [items, regions, running, engine, document, documentKey, t]);
	const reflowItems = useMemo(() => {
		// Revision changes when an individual preview is published.
		void revision;
		const value = session.current;
		return value && value.document === document ? value.decorate(items) : items;
	}, [items, document, revision]);
	const exportPdf = useCallback(
		async (dual = false) => {
			const value = session.current;
			const output = value?.output;
			if (!output || current.current.running) return;
			try {
				const { save } = await import("@tauri-apps/plugin-dialog");
				const path = await save({
					defaultPath: dual ? "bilingual.pdf" : "translated.pdf",
					filters: [{ name: "PDF", extensions: ["pdf"] }],
				});
				if (
					path &&
					session.current === value &&
					value.output === output &&
					!current.current.running
				) {
					const ctx = current.current.context?.();
					const bytes =
						dual && ctx
							? await interleaveReflowPdf(
									new Uint8Array(
										await ctx.engine.saveAsCopy(ctx.document).toPromise(),
									),
									output,
								)
							: output;
					await writeVaultBytes(path, bytes);
				}
			} catch (error) {
				notifyError(t("pdf.layoutTranslate.reflowFailed"), {
					description: errorText(error),
				});
			}
		},
		[t],
	);
	return {
		prepare,
		reflowItems,
		reflowBusy: session.current?.busy ?? false,
		reflowReady: !running && Boolean(session.current?.output),
		/** Finished translated PDF bytes; opened as a display document. */
		reflowOutput: session.current?.output ?? null,
		reflowProgress: session.current?.progress ?? 0,
		exportTranslatedPdf: exportPdf,
	};
}
