/**
 * Collect DOM text runs and hyperlinks from the export surface so PDF export
 * can add a selectable text layer + clickable link annotations on top of the
 * visual raster (html-to-image alone produces non-selectable pages).
 */

export type ExportTextRun = {
	text: string;
	/** CSS px relative to surface top-left. */
	x: number;
	y: number;
	width: number;
	height: number;
	fontSize: number;
};

export type ExportLinkRun = {
	href: string;
	x: number;
	y: number;
	width: number;
	height: number;
};

export type ExportTextLayer = {
	surfaceWidth: number;
	surfaceHeight: number;
	runs: ExportTextRun[];
	links: ExportLinkRun[];
};

function isSkippableTextParent(el: Element | null): boolean {
	if (!el) return true;
	if (el.closest("[data-export-ignore='true']")) return true;
	const tag = el.tagName.toLowerCase();
	if (tag === "script" || tag === "style" || tag === "noscript") return true;
	return false;
}

/**
 * Snapshot text + link geometry from a painted export surface.
 * Call after embeds/images are ready (same layout as capture).
 */
export function collectExportTextLayer(surface: HTMLElement): ExportTextLayer {
	const surfaceRect = surface.getBoundingClientRect();
	const surfaceWidth = Math.max(1, surface.scrollWidth || surfaceRect.width);
	const surfaceHeight = Math.max(1, surface.scrollHeight || surfaceRect.height);
	const runs: ExportTextRun[] = [];
	const links: ExportLinkRun[] = [];

	const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
	let current: Node | null = walker.nextNode();
	while (current) {
		const textNode = current as Text;
		current = walker.nextNode();
		const raw = textNode.nodeValue ?? "";
		if (!raw.trim()) continue;
		const parent = textNode.parentElement;
		if (isSkippableTextParent(parent)) continue;
		const style = getComputedStyle(parent as Element);
		if (
			style.visibility === "hidden" ||
			style.display === "none" ||
			style.opacity === "0"
		) {
			continue;
		}
		const fontSize = Number.parseFloat(style.fontSize) || 14;
		const range = document.createRange();
		range.selectNodeContents(textNode);
		const rect = range.getBoundingClientRect();
		if (rect.width < 0.5 || rect.height < 0.5) continue;
		const x = rect.left - surfaceRect.left + surface.scrollLeft;
		const y = rect.top - surfaceRect.top + surface.scrollTop;
		if (x + rect.width < 0 || y + rect.height < 0) continue;
		if (x > surfaceWidth || y > surfaceHeight) continue;
		runs.push({
			text: raw,
			x,
			y,
			width: rect.width,
			height: rect.height,
			fontSize,
		});
	}

	for (const anchor of surface.querySelectorAll("a[href]")) {
		if (!(anchor instanceof HTMLAnchorElement)) continue;
		if (isSkippableTextParent(anchor)) continue;
		const href = (anchor.getAttribute("href") || "").trim();
		if (!href || href.startsWith("javascript:") || href === "#") continue;
		const style = getComputedStyle(anchor);
		if (
			style.visibility === "hidden" ||
			style.display === "none" ||
			style.opacity === "0"
		) {
			continue;
		}
		const rect = anchor.getBoundingClientRect();
		if (rect.width < 0.5 || rect.height < 0.5) continue;
		const x = rect.left - surfaceRect.left + surface.scrollLeft;
		const y = rect.top - surfaceRect.top + surface.scrollTop;
		links.push({
			href,
			x,
			y,
			width: rect.width,
			height: rect.height,
		});
	}

	return { surfaceWidth, surfaceHeight, runs, links };
}
