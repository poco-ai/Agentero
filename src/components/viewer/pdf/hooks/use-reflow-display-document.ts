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

/** Closing a hidden display document is best-effort; teardown is not an error. */
function closeDisplayDocument(
	docCap: DocumentManagerCapability | null | undefined,
	id: string,
): void {
	docCap?.closeDocument(id).wait(
		() => {},
		() => {},
	);
}

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
			generation.current += 1;
			const previous = active.current;
			active.current = null;
			setDisplayId(null);
			if (previous) closeDisplayDocument(docCap, previous.id);
			return;
		}
		if (active.current?.source === output) return;
		const token = ++generation.current;
		const id = `reflow-display-${docId}-${++sequence}`;
		let cancelled = false;
		const superseded = () => cancelled || token !== generation.current;

		docCap
			.openDocumentBuffer({
				buffer: output.slice().buffer,
				name: id,
				documentId: id,
				autoActivate: false,
			})
			.wait(
				({ task }) => {
					// The manager's outer task resolves when loading *starts*. Publish
					// the render id only after PDFium actually has the document;
					// render layers would otherwise request pages from a document
					// that is still loading (`Document … not loaded`).
					task.wait(
						() => {
							if (superseded()) {
								closeDisplayDocument(docCap, id);
								return;
							}
							const previous = active.current;
							active.current = { source: output, id };
							setDisplayId(id);
							if (previous) closeDisplayDocument(docCap, previous.id);
						},
						() => {
							// Keep the static per-page preview as the fallback. Release the
							// failed entry so it does not linger in the document manager.
							closeDisplayDocument(docCap, id);
							if (superseded()) return;
							const previous = active.current;
							active.current = null;
							setDisplayId(null);
							if (previous) closeDisplayDocument(docCap, previous.id);
						},
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
			generation.current += 1;
			const current = active.current;
			active.current = null;
			if (current) closeDisplayDocument(docCap, current.id);
		};
	}, [docCap]);

	return displayId;
}
