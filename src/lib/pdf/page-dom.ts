/**
 * Markers the rendered PDF page wrappers carry. Kept in `lib` so DOM-level
 * coordination (selection, overlays, zoom preview) does not have to reach into
 * the viewer components for the attribute name.
 */

/** Marks a rendered page wrapper so overlays/menus can map page↔screen coords. */
export const EMBED_PAGE_ATTR = "data-embed-pdf-page";
