/**
 * Referentially-stable derived value for the PDF viewer's page-render path.
 *
 * Streaming (ask / translate) replaces the whole mark array on every chunk even
 * though the geometry-relevant fields (anchor rects, page, preview) are untouched.
 * A `useMemo` keyed on those arrays therefore returns a fresh identity per chunk,
 * which churns `pinsByPage` → `pageMarks` → `renderPage` and forces the Scroller
 * to re-render every mounted page for every streamed token.
 *
 * This hook re-derives only when the caller-provided `fingerprint` (a string over
 * the fields the derivation actually reads) changes, and otherwise returns the
 * cached reference. The fingerprint is a plain primitive, so downstream memos
 * keep their identity across chunks.
 */

import { useRef } from "react";

export function useStableDerived<T>(derive: () => T, fingerprint: string): T {
	const cacheRef = useRef<{ fingerprint: string; value: T } | null>(null);
	if (!cacheRef.current || cacheRef.current.fingerprint !== fingerprint) {
		cacheRef.current = { fingerprint, value: derive() };
	}
	return cacheRef.current.value;
}
