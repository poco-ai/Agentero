/**
 * Registers the finished translated PDF as a hidden document in the viewer's
 * document manager. The translation overlay then renders its pages through the
 * same tiling/render stack as the source PDF, so text stays at native device
 * resolution at every zoom instead of being a stretched preview raster.
 *
 * The document is never activated (autoActivate: false), so opening and closing
 * it does not move the viewer's current document.
 */

import type { useDocumentManagerCapability } from "@embedpdf/plugin-document-manager/react";
import { useEffect, useRef, useState } from "react";

type DocumentManagerCapability = ReturnType<
	typeof useDocumentManagerCapability
>["provides"];

let sequence = 0;

export function useReflowDisplayDocument(
	docCap: DocumentManagerCapability | null | undefined,
	output: Uint8Array | null | undefined,
	docId: string,
): string | null {
	const [displayId, setDisplayId] = useState<string | null>(null);
	const active = useRef<{ source: Uint8Array; id: string } | null>(null);
	const generation = useRef(0);

	useEffect(() => {
		if (!docCap || !output) {
			const previous = active.current;
			active.current = null;
			setDisplayId(null);
			if (previous)
				docCap?.closeDocument(previous.id).wait(
					() => {},
					() => {},
				);
			return;
		}
		if (active.current?.source === output) return;
		const token = ++generation.current;
		const id = `reflow-display-${docId}-${++sequence}`;
		let cancelled = false;
		docCap
			.openDocumentBuffer({
				buffer: output.slice().buffer,
				name: id,
				documentId: id,
				autoActivate: false,
			})
			.wait(
				() => {
					if (cancelled || token !== generation.current) {
						docCap.closeDocument(id).wait(
							() => {},
							() => {},
						);
						return;
					}
					const previous = active.current;
					active.current = { source: output, id };
					setDisplayId(id);
					if (previous)
						docCap.closeDocument(previous.id).wait(
							() => {},
							() => {},
						);
				},
				() => {
					// Keep the static per-page preview as the fallback.
				},
			);
		return () => {
			cancelled = true;
		};
	}, [docCap, output, docId]);

	useEffect(() => {
		return () => {
			const current = active.current;
			active.current = null;
			if (current)
				docCap?.closeDocument(current.id).wait(
					() => {},
					() => {},
				);
		};
	}, [docCap]);

	return displayId;
}
