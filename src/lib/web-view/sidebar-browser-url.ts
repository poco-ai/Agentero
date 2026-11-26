import { isMacOS, isMobileApp, isTauri } from "@/lib/core/tauri";
import { isMarkdownPath } from "@/lib/vault/path-kinds";
import { isHtmlPath } from "@/lib/workspace/viewer";

export type SidebarBrowserTarget = { kind: "browser"; url: string | null };

export function supportsSidebarBrowser(): boolean {
	return isTauri() && isMacOS() && !isMobileApp();
}

export function sidebarBrowserUrl(
	input: string,
	allowBareFileName = false,
): string | null {
	const text = input.trim();
	if (!text || /[\s\\]/.test(text)) return null;
	const explicit = /^https?:\/\//i.test(text);
	if (!explicit) {
		const host = text.split(/[/?#]/, 1)[0];
		if (!/^(?:localhost|[^.:]+(?:\.[^.:]+)+)(?::\d+)?$/i.test(host))
			return null;
		if (
			!allowBareFileName &&
			(isHtmlPath(host) || isMarkdownPath(host) || /\.pdf$/i.test(host))
		)
			return null;
		if (
			!/^localhost(?::\d+)?$/i.test(host) &&
			!/\.[\p{L}][\p{L}\d-]*(?::\d+)?$/u.test(host) &&
			!/^\d+(?:\.\d+){3}(?::\d+)?$/.test(host)
		)
			return null;
	}
	try {
		const url = new URL(explicit ? text : `https://${text}`);
		return url.hostname && !url.username && !url.password ? url.href : null;
	} catch {
		return null;
	}
}
