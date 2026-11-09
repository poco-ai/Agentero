import { type RefObject, useCallback, useEffect } from "react";
import {
	closeSelectionSource,
	dismissSelectionChat,
	openSelectionChat,
	selectionChatStore,
} from "@/lib/agent/selection-chat-store";
import { relaySelectionDismiss } from "@/lib/agent/selection-dismiss";
import {
	runSelectionAddToChat,
	runSelectionQuickChat,
} from "@/lib/agent/selection-quick-chat";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { openExternalUrl } from "@/lib/core/open-external";
import { getPlatformOS } from "@/lib/core/tauri";
import { settingsStore } from "@/lib/settings/react-store";
import { getShortcut, resolveShortcutId } from "@/lib/shell/shortcuts";
import { toggleChat } from "@/lib/shell/ui-window-actions";
import { webViewProxyOrigins } from "@/lib/web-view/proxy-url";
import { bridgeSelectionScreen, parseWebBridgeMessage } from "./bridge-message";

/** Frame adapter only: shared window host owns menus, requests and result cards. */
export function useWebViewSelection({
	srcUrl,
	iframeRef,
	title,
	origin,
	scale = 1,
}: {
	srcUrl: string;
	iframeRef: RefObject<HTMLIFrameElement | null>;
	title?: string;
	/** Explicit proxy origin, or "null" only for a sandboxed srcdoc frame. */
	origin?: string;
	scale?: number;
}) {
	const syncShortcuts = useCallback(() => {
		iframeRef.current?.contentWindow?.postMessage(
			{
				source: "agentero-web-host",
				type: "shortcuts",
				isMac: getPlatformOS() === "macos",
				bindings: (["toggleChat", "quickChat", "addSelectionToChat"] as const)
					.map((id) =>
						getShortcut(id, settingsStore.getState().shortcutOverrides),
					)
					.filter(Boolean),
			},
			origin && origin !== "null" ? origin : "*",
		);
	}, [iframeRef, origin]);
	useEffect(() => {
		syncShortcuts();
		return settingsStore.subscribe(syncShortcuts);
	}, [syncShortcuts]);
	useEffect(() => {
		let selectionSource = srcUrl;
		const closeMenu = () => {
			const draft = selectionChatStore.getState().draft;
			if (
				draft?.stage === "menu" &&
				draft.selection.sourcePath === selectionSource
			)
				dismissSelectionChat();
		};
		const onMessage = (event: MessageEvent) => {
			const origins = origin ? [origin] : webViewProxyOrigins();
			if (
				!origins.includes(event.origin) ||
				event.source !== iframeRef.current?.contentWindow
			)
				return;
			const msg = parseWebBridgeMessage(event.data);
			if (!msg) return;
			if (msg.type === "ready") {
				syncShortcuts();
				return;
			}
			if (msg.type === "selection") {
				const iframe = iframeRef.current;
				if (!iframe || !msg.text || !msg.rect) {
					closeMenu();
					return;
				}
				const bounds = iframe.getBoundingClientRect();
				if (!bounds.width || !bounds.height) return;
				// Reconstruct the current public page after in-frame navigation.
				let url = srcUrl;
				try {
					const remote = new URL(srcUrl);
					const frame = new URL(msg.url);
					const frameOrigin =
						frame.origin === "null"
							? `${frame.protocol}//${frame.host}`
							: frame.origin;
					if (frame.protocol === "http:" || frame.protocol === "https:") {
						if (!origins.includes(frameOrigin)) url = frame.href;
					}
					if (origins.includes(frameOrigin)) {
						const prefix = `/${remote.host}`;
						const path = frame.pathname.startsWith(`${prefix}/`)
							? frame.pathname.slice(prefix.length)
							: frame.pathname;
						url = new URL(path + frame.search + frame.hash, remote.origin).href;
					}
				} catch {
					/* sandboxed srcdoc uses the supplied public URL */
				}
				if (selectionSource !== url) closeSelectionSource(selectionSource);
				selectionSource = url;
				openSelectionChat(
					{
						text: msg.text,
						sourcePath: url,
						sourceUrl: url,
						sourceTitle: title,
						origin: "markdown",
						surface: "web",
					},
					bridgeSelectionScreen(
						{
							x: msg.rect.x * scale,
							y: msg.rect.y * scale,
							width: msg.rect.width * scale,
							height: msg.rect.height * scale,
						},
						bounds,
					),
					"menu",
				);
				void copyTextToClipboard(msg.text);
			} else if (msg.type === "scroll") closeMenu();
			else if (msg.type === "escape") relaySelectionDismiss();
			else if (msg.type === "shortcut") {
				const id = resolveShortcutId(new KeyboardEvent("keydown", msg.event), {
					settingsOpen: false,
				});
				if (id === "toggleChat") toggleChat();
				else if (
					selectionChatStore.getState().draft?.selection.sourcePath ===
					selectionSource
				) {
					if (id === "quickChat") runSelectionQuickChat();
					else if (id === "addSelectionToChat" && runSelectionAddToChat())
						iframeRef.current?.contentWindow?.postMessage(
							{ source: "agentero-web-host", type: "clearSelection" },
							"*",
						);
				}
			} else if (msg.type === "external") openExternalUrl(msg.url);
		};
		window.addEventListener("message", onMessage);
		return () => {
			window.removeEventListener("message", onMessage);
			closeSelectionSource(selectionSource);
		};
	}, [srcUrl, iframeRef, title, origin, scale, syncShortcuts]);
	return { onFrameLoad: syncShortcuts };
}
