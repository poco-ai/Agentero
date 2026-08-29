"use client";

import { ExternalLink, Link2 } from "lucide-react";
import { NodeApi, type TElement } from "platejs";
import type { PlateElementProps } from "platejs/react";
import {
	PlateElement,
	useEditorRef,
	useElement,
	useReadOnly,
} from "platejs/react";
import type { KeyboardEvent, MouseEvent } from "react";
import { useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { linkClassName } from "@/components/editor/nodes/inline/link-styles";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Popover,
	PopoverAnchor,
	PopoverContent,
} from "@/components/ui/popover";
import { openExternalUrl } from "@/lib/core/open-external";
import {
	clearExternalLinkEditRequest,
	peekExternalLinkEditId,
	selectAfterInlineNode,
} from "@/lib/markdown/external-link-insert";

type LinkEl = TElement & {
	url?: string;
	/** Set on slash/context-menu insert; cleared after the edit popover opens. */
	agenteroEditId?: string;
};

function openIfExternal(url: string) {
	const trimmed = url.trim();
	if (trimmed) openExternalUrl(trimmed);
}

/**
 * External Markdown link: plain click opens an edit popover (label + URL);
 * ⌘/Ctrl+click, middle-click, or right-click opens the system browser.
 */
export function ExternalLinkElement(props: PlateElementProps) {
	const { t } = useTranslation("editor");
	const { children, element } = props;
	const editor = useEditorRef();
	const linkElement = useElement<LinkEl>();
	const readOnly = useReadOnly();
	const url = (element as LinkEl).url ?? "";
	const editId = (linkElement as LinkEl).agenteroEditId;
	const [open, setOpen] = useState(false);
	const [draftLabel, setDraftLabel] = useState("");
	const [draftUrl, setDraftUrl] = useState(url);
	const labelId = useId();
	const urlId = useId();
	const anchorRef = useRef<HTMLElement | null>(null);
	const openedEditIdRef = useRef<string | null>(null);
	/** Ignore Radix dismiss events for a short window after auto-open. */
	const ignoreDismissUntilRef = useRef(0);
	const virtualRef = useRef({
		getBoundingClientRect: () =>
			anchorRef.current?.getBoundingClientRect() ?? new DOMRect(),
	});

	useEffect(() => {
		if (!open) return;
		setDraftLabel(NodeApi.string(linkElement));
		setDraftUrl((linkElement as LinkEl).url ?? "");
	}, [open, linkElement]);

	// Slash / context-menu insert stamps `agenteroEditId` + editor pending id.
	// Open once when they match. Pending is cleared only when we actually open
	// (so Strict Mode remount / effect cleanup cannot drop the request early).
	useEffect(() => {
		if (readOnly || !editId) return;
		if (openedEditIdRef.current === editId) return;
		if (peekExternalLinkEditId(editor) !== editId) return;

		// Delay past slash-menu unmount + any focus restoration.
		const timer = window.setTimeout(() => {
			if (openedEditIdRef.current === editId) return;
			if (peekExternalLinkEditId(editor) !== editId) return;
			openedEditIdRef.current = editId;
			clearExternalLinkEditRequest(editor, editId);
			ignoreDismissUntilRef.current = Date.now() + 300;
			setOpen(true);
		}, 50);

		return () => {
			window.clearTimeout(timer);
		};
	}, [editor, editId, readOnly]);

	const handleOpenChange = (next: boolean) => {
		// Programmatic open can race with focus/outside events from the slash
		// menu teardown; ignore dismiss for a short grace period.
		if (!next && Date.now() < ignoreDismissUntilRef.current) {
			return;
		}
		setOpen(next);
	};

	const openBrowser = (event?: MouseEvent) => {
		event?.preventDefault();
		event?.stopPropagation();
		openIfExternal((linkElement as LinkEl).url ?? url);
	};

	const applyEdits = () => {
		const path = editor.api.findPath(linkElement);
		if (!path) {
			setOpen(false);
			return;
		}
		const nextUrl = draftUrl.trim();
		const nextLabel = draftLabel;
		editor.tf.withoutNormalizing(() => {
			editor.tf.setNodes({ url: nextUrl }, { at: path });
			const start = editor.api.start(path);
			const end = editor.api.end(path);
			if (start && end) {
				editor.tf.select({ anchor: start, focus: end });
				editor.tf.insertText(nextLabel.length > 0 ? nextLabel : nextUrl);
			}
		});
		setOpen(false);
		// Stay on the same line, immediately after the link (not a new block).
		selectAfterInlineNode(editor, path);
		editor.tf.focus();
	};

	const onTriggerClick = (event: MouseEvent) => {
		if (event.metaKey || event.ctrlKey) {
			openBrowser(event);
			return;
		}
		if (event.button !== 0) return;
		event.preventDefault();
		event.stopPropagation();
		if (readOnly) {
			openIfExternal(url);
			return;
		}
		setOpen(true);
	};

	const onContextMenu = (event: MouseEvent) => {
		openBrowser(event);
	};

	const onAuxClick = (event: MouseEvent) => {
		if (event.button !== 1) return;
		openBrowser(event);
	};

	const slateRef = props.attributes.ref;
	const setRefs = (node: HTMLElement | null) => {
		anchorRef.current = node;
		if (typeof slateRef === "function") {
			slateRef(node);
		} else if (slateRef && typeof slateRef === "object") {
			(slateRef as { current: HTMLElement | null }).current = node;
		}
	};

	// Render as span (not <a>) so the webview does not fight DOM selection when
	// the link is deleted — avoids WebKit "The object can not be found here."
	return (
		<Popover open={open} onOpenChange={handleOpenChange} modal={false}>
			<PopoverAnchor virtualRef={virtualRef} />
			<PlateElement
				{...props}
				as="span"
				className={linkClassName}
				attributes={{
					...props.attributes,
					ref: setRefs,
					role: "link",
					"data-url": url,
					title: url || undefined,
					onClick: onTriggerClick,
					onContextMenu,
					onAuxClick,
					onKeyDown: (event: KeyboardEvent) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							event.stopPropagation();
							if (readOnly) openIfExternal(url);
							else setOpen(true);
						}
					},
				}}
			>
				{children}
			</PlateElement>
			<PopoverContent
				align="start"
				sideOffset={6}
				// Above dockview sashes (z-index: calc(--dv-overlay-z-index + …) ≥ 1000)
				// so the editor's split divider never paints over this popover.
				className="z-[1100] w-80 gap-3 p-3"
				onOpenAutoFocus={(event) => {
					event.preventDefault();
					window.requestAnimationFrame(() => {
						const el = document.getElementById(urlId);
						el?.focus();
						if (el instanceof HTMLInputElement) el.select();
					});
				}}
				onCloseAutoFocus={(event) => {
					event.preventDefault();
					const path = editor.api.findPath(linkElement);
					if (path) selectAfterInlineNode(editor, path);
					editor.tf.focus({ at: editor.selection ?? undefined });
				}}
				onPointerDownOutside={(event) => {
					const target = event.target;
					if (
						target instanceof HTMLElement &&
						target.closest("[data-editor-completion='slash']")
					) {
						event.preventDefault();
					}
				}}
				onMouseDown={(event) => {
					const target = event.target;
					if (
						target instanceof HTMLElement &&
						target.closest(
							"input, textarea, button, select, [role='textbox'], [data-slot='input']",
						)
					) {
						event.stopPropagation();
					}
				}}
			>
				<div className="flex items-center gap-1.5 font-medium text-sm">
					<Link2 className="size-3.5 text-muted-foreground" aria-hidden />
					{t("externalLink.editTitle")}
				</div>
				<div className="grid gap-2">
					<div className="grid gap-1">
						<Label htmlFor={labelId} className="text-muted-foreground text-xs">
							{t("externalLink.labelField")}
						</Label>
						<Input
							id={labelId}
							value={draftLabel}
							onChange={(e) => setDraftLabel(e.target.value)}
							onMouseDown={(e) => e.stopPropagation()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									e.stopPropagation();
									applyEdits();
								}
							}}
							placeholder={t("externalLink.labelPlaceholder")}
							autoComplete="off"
						/>
					</div>
					<div className="grid gap-1">
						<Label htmlFor={urlId} className="text-muted-foreground text-xs">
							{t("externalLink.urlField")}
						</Label>
						<Input
							id={urlId}
							value={draftUrl}
							onChange={(e) => setDraftUrl(e.target.value)}
							onMouseDown={(e) => e.stopPropagation()}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									e.stopPropagation();
									applyEdits();
								}
							}}
							placeholder="https://"
							autoComplete="off"
							spellCheck={false}
						/>
					</div>
				</div>
				<div className="flex items-center justify-end gap-2">
					<Button
						type="button"
						variant="outline"
						size="sm"
						onMouseDown={(e) => e.stopPropagation()}
						onClick={() => openIfExternal(draftUrl || url)}
					>
						<ExternalLink className="size-3.5" aria-hidden />
						{t("externalLink.open")}
					</Button>
					<Button
						type="button"
						size="sm"
						onMouseDown={(e) => e.stopPropagation()}
						onClick={applyEdits}
					>
						{t("externalLink.apply")}
					</Button>
				</div>
			</PopoverContent>
		</Popover>
	);
}
