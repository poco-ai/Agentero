import { LoaderCircle } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { bridgeRpc } from "@/lib/bridge/client";
import { loadBridgePaperPdf } from "@/lib/bridge/pdf";
import { paperRemoteAssetsFromMetadata } from "@/lib/paper";
import type { PaperMetadata } from "@/lib/paper/types";

const MobilePdfViewer = lazy(() =>
	import("@/components/viewer/pdf/pdf-viewer").then((module) => ({
		default: module.PdfViewer,
	})),
);

export function MobileReaderPage({
	paper,
	mode,
}: {
	paper: PaperMetadata;
	mode: "pdf" | "notes";
}) {
	const { t } = useTranslation("mobile");
	const [notes, setNotes] = useState("");
	const [saving, setSaving] = useState(false);
	const [pdfSource, setPdfSource] = useState<string | null>(null);
	const [pdfBytes, setPdfBytes] = useState<ArrayBuffer | null>(null);
	const [pdfError, setPdfError] = useState<string | null>(null);

	useEffect(() => {
		setNotes("");
		setPdfSource(null);
		setPdfBytes(null);
		setPdfError(null);
		let active = true;
		if (paper.path) {
			void bridgeRpc<string>("vault_read_text", {
				path: `${paper.path}/NOTES.md`,
			})
				.then((content) => active && setNotes(content))
				.catch(() => undefined);
		}

		const remotePdf = paperRemoteAssetsFromMetadata(paper).pdfUrl;
		const loadPdf = async () => {
			if (remotePdf) {
				try {
					const response = await fetch(remotePdf, {
						method: "HEAD",
						redirect: "follow",
					});
					if (response.ok) {
						if (active) setPdfSource(remotePdf);
						return;
					}
				} catch {
					// Fall back to the encrypted Bridge transfer below.
				}
			}

			if (!paper.path) {
				if (active) setPdfError(t("reader.pdfUnavailable"));
				return;
			}
			try {
				const blob = await loadBridgePaperPdf(paper.path);
				const bytes = await blob.arrayBuffer();
				if (active) setPdfBytes(bytes);
			} catch (error) {
				if (!active) return;
				setPdfError(
					error instanceof Error ? error.message : t("reader.pdfUnavailable"),
				);
			}
		};
		void loadPdf();
		return () => {
			active = false;
		};
	}, [paper, t]);

	const save = async () => {
		if (!paper.path) return;
		setSaving(true);
		try {
			await bridgeRpc("vault_write_text", {
				path: `${paper.path}/NOTES.md`,
				content: notes,
			});
		} finally {
			setSaving(false);
		}
	};
	const pdf = (
		<MobilePdfPreview
			source={pdfSource}
			bytes={pdfBytes}
			error={pdfError}
			docId={`bridge:${paper.id}`}
			paperPath={paper.path ?? null}
		/>
	);
	const notesEditor = (
		<div className="relative flex h-full min-h-0 flex-1 flex-col">
			<div className="min-h-0 flex-1 overflow-y-auto pb-20">
				<Textarea
					value={notes}
					onChange={(event) => setNotes(event.target.value)}
					className="min-h-full w-full resize-none overflow-y-auto rounded-none border-0 p-4 font-mono text-base leading-6 shadow-none field-sizing-fixed focus-visible:ring-0 md:px-6 md:text-[15px]"
				/>
			</div>
			<footer className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-end border-t bg-background/95 px-4 py-3 backdrop-blur md:px-6">
				<Button
					size="sm"
					className="pointer-events-auto"
					disabled={saving}
					onClick={() => void save()}
				>
					{saving ? <LoaderCircle className="size-3.5 animate-spin" /> : null}
					{saving ? t("reader.saving") : t("reader.save")}
				</Button>
			</footer>
		</div>
	);
	return (
		<section className="flex h-full min-h-0 flex-col">
			<div className="h-full min-h-0 flex-1 md:hidden">
				{mode === "pdf" ? pdf : notesEditor}
			</div>
			<div className="hidden min-h-0 flex-1 md:grid md:grid-cols-2 md:divide-x">
				{pdf}
				{notesEditor}
			</div>
		</section>
	);
}

function MobilePdfPreview({
	source,
	bytes,
	error,
	docId,
	paperPath,
}: {
	source: string | null;
	bytes: ArrayBuffer | null;
	error: string | null;
	docId: string;
	paperPath: string | null;
}) {
	const { t } = useTranslation("mobile");
	if (error) {
		return (
			<div className="grid h-full place-items-center p-6 text-center text-muted-foreground text-sm">
				{error || t("reader.pdfUnavailable")}
			</div>
		);
	}
	if (!source && !bytes) {
		return (
			<div className="grid h-full place-items-center gap-2 text-muted-foreground text-sm">
				<LoaderCircle className="size-5 animate-spin" />
				{t("reader.loadingPdf")}
			</div>
		);
	}
	return (
		<div className="h-full min-h-0">
			<Suspense
				fallback={
					<div className="grid h-full place-items-center">
						<LoaderCircle className="size-5 animate-spin text-muted-foreground" />
					</div>
				}
			>
				<MobilePdfViewer
					source={source}
					sourceBytes={bytes}
					docId={docId}
					paperRelPath={paperPath}
					className="h-full"
				/>
			</Suspense>
		</div>
	);
}
