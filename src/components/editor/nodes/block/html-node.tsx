"use client";

import { CornerDownLeftIcon, PencilIcon } from "lucide-react";
import type { TElement } from "platejs";
import {
	PlateElement,
	type PlateElementProps,
	useEditorRef,
	useReadOnly,
	useSelected,
} from "platejs/react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import { useMarkdownDoc } from "@/components/editor/context/markdown-doc-context";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/core/utils";
import { sanitizeEmbeddedHtml } from "@/lib/markdown/html-sanitize";

type HtmlBlockElementNode = TElement & { html?: string };

export function HtmlBlockElement(
	props: PlateElementProps<HtmlBlockElementNode>,
) {
	const { t } = useTranslation("editor");
	const editor = useEditorRef();
	const readOnly = useReadOnly();
	const selected = useSelected();
	const htmlPreview = useMarkdownDoc().openHtmlPreview;
	const [open, setOpen] = React.useState(false);

	const source = props.element.html ?? "";
	const rendered = React.useMemo(() => sanitizeEmbeddedHtml(source), [source]);
	const [draft, setDraft] = React.useState(source);

	React.useEffect(() => {
		if (!open) setDraft(source);
	}, [open, source]);

	const commit = () => {
		setOpen(false);
		const path = editor.api.findPath(props.element);
		if (path && draft !== source)
			editor.tf.setNodes({ html: draft }, { at: path });
	};

	const openPreview = (
		event: React.MouseEvent<HTMLElement> | React.KeyboardEvent<HTMLElement>,
	) => {
		if (!htmlPreview || !source.trim()) return;
		event.preventDefault();
		event.stopPropagation();
		htmlPreview(source);
	};

	const preview = rendered ? (
		// Sanitized by sanitizeEmbeddedHtml: scripts, styles and event handlers
		// are stripped and iframes are forced into a referrer-less sandbox.
		// biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above
		<div dangerouslySetInnerHTML={{ __html: rendered }} />
	) : (
		<code className="block whitespace-pre-wrap break-all font-mono text-muted-foreground text-xs">
			{source}
		</code>
	);

	if (readOnly) {
		return (
			<PlateElement {...props}>
				{/* biome-ignore lint/a11y/useSemanticElements: sanitized block content can include iframes/divs, which are invalid inside <button> */}
				<div
					contentEditable={false}
					role="button"
					tabIndex={htmlPreview ? 0 : undefined}
					title={htmlPreview ? t("html.preview") : undefined}
					className={cn(
						"rounded-sm px-1 py-0.5",
						htmlPreview && "cursor-zoom-in hover:bg-primary/5",
					)}
					onClick={openPreview}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") openPreview(event);
					}}
				>
					{preview}
				</div>
				{props.children}
			</PlateElement>
		);
	}

	return (
		<PlateElement {...props}>
			<div
				className={cn(
					"group/html relative rounded-sm",
					selected && "bg-primary/10",
				)}
				contentEditable={false}
			>
				{/* biome-ignore lint/a11y/useSemanticElements: sanitized block content can include iframes/divs, which are invalid inside <button> */}
				<div
					role="button"
					tabIndex={htmlPreview ? 0 : undefined}
					title={htmlPreview ? t("html.preview") : undefined}
					className={cn(
						"rounded-sm px-1 py-0.5",
						htmlPreview && "cursor-zoom-in hover:bg-primary/5",
					)}
					onClick={openPreview}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") openPreview(event);
					}}
				>
					{preview}
				</div>
				<Popover open={open} onOpenChange={setOpen} modal={false}>
					<PopoverTrigger asChild>
						<Button
							type="button"
							variant="secondary"
							size="icon"
							title={t("html.edit")}
							aria-label={t("html.edit")}
							className={cn(
								"absolute top-1 right-1 z-10 size-6 opacity-0 shadow-raised",
								"transition-opacity duration-150 ease-out motion-reduce:transition-none",
								"group-hover/html:opacity-100 focus-visible:opacity-100 data-[state=open]:opacity-100",
							)}
						>
							<PencilIcon className="size-3.5" />
						</Button>
					</PopoverTrigger>
					<PopoverContent
						className="flex w-(--radix-popover-trigger-width) min-w-80 gap-2"
						onEscapeKeyDown={(event) => event.preventDefault()}
						contentEditable={false}
					>
						<textarea
							// biome-ignore lint/a11y/noAutofocus: matches the equation editor
							autoFocus
							aria-label={t("html.edit")}
							className="agentero-scroll max-h-[50vh] min-h-24 grow resize-none rounded-md border bg-transparent p-2 font-mono text-sm outline-none"
							placeholder={t("html.placeholder")}
							value={draft}
							onChange={(event) => setDraft(event.target.value)}
						/>
						<Button variant="secondary" className="px-3" onClick={commit}>
							<CornerDownLeftIcon className="size-3.5" />
						</Button>
					</PopoverContent>
				</Popover>
			</div>
			{props.children}
		</PlateElement>
	);
}
