export type CenterViewMode =
	| "markdown"
	| "pdf"
	| "html"
	| "image"
	| "translation";

export function isPdfPath(path: string): boolean {
	return /\.pdf$/i.test(path);
}

export function isHtmlPath(path: string): boolean {
	return /\.html?$/i.test(path);
}

/** Common image extensions previewable in the center pane. */
export function isImagePath(path: string): boolean {
	return /\.(png|jpe?g|gif|webp|bmp|svg|avif|ico)$/i.test(path);
}

/** MIME type for local image → blob: preview. */
export function imageMimeFromPath(path: string): string {
	const m = path.match(/\.([a-z0-9]+)$/i);
	const ext = (m?.[1] ?? "").toLowerCase();
	switch (ext) {
		case "png":
			return "image/png";
		case "jpg":
		case "jpeg":
			return "image/jpeg";
		case "gif":
			return "image/gif";
		case "webp":
			return "image/webp";
		case "bmp":
			return "image/bmp";
		case "svg":
			return "image/svg+xml";
		case "avif":
			return "image/avif";
		case "ico":
			return "image/x-icon";
		default:
			return "application/octet-stream";
	}
}

/** True when a string can be used as an <img> src (blob: or remote). */
export function isImageViewerSource(
	source: string | null | undefined,
): source is string {
	if (!source?.trim()) return false;
	const s = source.trim();
	return /^(https?|blob|data):/i.test(s);
}

export function preferredModeForPath(path: string | null): CenterViewMode {
	if (!path) return "markdown";
	if (isPdfPath(path)) return "pdf";
	if (isHtmlPath(path)) return "html";
	if (isImagePath(path)) return "image";
	return "markdown";
}
