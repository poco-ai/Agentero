"use client";

import {
	PlateElement,
	type PlateElementProps,
	useSelected,
} from "platejs/react";
import { type MouseEvent, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useMarkdownDoc } from "@/components/editor/context/markdown-doc-context";
import { WikiEmbedElement } from "@/components/editor/embeds/wiki-embed-node";
import { cn } from "@/lib/core/utils";
import {
	type LinkFragment,
	navFromResolvedLink,
	resolveWikiReference,
	resolveWikiTarget,
} from "@/lib/wiki";
import { useWikiNav } from "@/lib/wiki/nav-context";
import type { WikiSlateNode } from "@/lib/wiki/wikilink-model";

export function WikiLinkElement(props: PlateElementProps) {
	const element = props.element as unknown as WikiSlateNode;
	const editing = useSelected();
	return element.embed ? (
		<WikiEmbedElement {...props} editing={editing} />
	) : (
		<WikiLinkNavigationElement {...props} editing={editing} />
	);
}

function WikiLinkNavigationElement({
	editing,
	...props
}: PlateElementProps & { editing: boolean }) {
	const { t } = useTranslation("editor");
	const el = props.element as unknown as WikiSlateNode;
	const wikiNav = useWikiNav();
	const markdownDoc = useMarkdownDoc();

	const target = el.value ?? "";
	const mdFiles = wikiNav?.mdFiles ?? [];
	// resolveWikiTarget scans the whole md file list several times over; this
	// component re-renders on every selection change that touches the link.
	const path = useMemo(
		() => resolveWikiTarget(target, mdFiles),
		[mdFiles, target],
	);
	const fragment: LinkFragment | undefined = el.heading
		? el.heading.startsWith("^")
			? { kind: "block", id: el.heading.slice(1) }
			: el.heading.startsWith("@")
				? { kind: "annotation", id: el.heading.slice(1) }
				: { kind: "heading", path: el.heading.split("#").filter(Boolean) }
		: undefined;
	const fallbackStatus = path || (!target && fragment) ? "resolved" : "missing";
	const withHeading = el.heading
		? el.heading.startsWith("@")
			? target
				? `${target}${el.heading}`
				: el.heading
			: target
				? `${target}#${el.heading}`
				: `#${el.heading}`
		: target;
	const label = el.alias || withHeading || target;

	const navigate = async (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		if (wikiNav?.vaultPath && markdownDoc.filePath) {
			try {
				const resolved = await resolveWikiReference(
					wikiNav.vaultPath,
					markdownDoc.filePath,
					withHeading,
				);
				if (resolved) {
					wikiNav.onWikiNavigate(navFromResolvedLink(resolved));
					return;
				}
			} catch {
				// Demo/offline fallback remains deliberately file-only.
			}
		}
		wikiNav?.onWikiNavigate({
			targetRaw: target,
			path,
			status: fallbackStatus,
			fragment,
		});
	};

	return (
		<PlateElement
			{...props}
			as="span"
			className={cn(
				"relative underline-offset-2 transition-colors",
				editing
					? "cursor-text font-normal text-foreground"
					: fallbackStatus === "resolved"
						? "cursor-pointer font-medium text-primary underline decoration-primary/40 hover:decoration-primary"
						: "cursor-pointer font-medium text-muted-foreground underline decoration-dashed decoration-muted-foreground/60 hover:text-foreground",
			)}
			attributes={{
				...props.attributes,
				title:
					fallbackStatus === "resolved"
						? (path ?? target)
						: t("missingLink", { target }),
				"data-wiki": fallbackStatus === "resolved" ? "ok" : "missing",
				onClick: editing ? undefined : navigate,
				"data-wiki-source": editing ? "link" : undefined,
			}}
		>
			<span className={editing ? "hidden" : undefined} contentEditable={false}>
				{label}
			</span>
			<span
				aria-hidden={editing ? undefined : true}
				className={
					editing
						? undefined
						: "pointer-events-none absolute size-px overflow-hidden opacity-0"
				}
			>
				{props.children}
			</span>
		</PlateElement>
	);
}
