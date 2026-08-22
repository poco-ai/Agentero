"use client";

import type { ComponentPropsWithoutRef } from "react";
import { useCallback } from "react";

import { openExternalUrl } from "@/lib/core/open-external";

type ExternalLinkProps = ComponentPropsWithoutRef<"a"> & {
	node?: unknown;
};

/**
 * Streamdown `<a>` renderer. Disables streamdown's built-in link-safety
 * confirmation modal and opens the link directly in the system browser.
 *
 * `target="_blank"` is intentionally dropped: Tauri's webview routes `_blank`
 * links natively, which would double-open alongside `openExternalUrl`.
 */
export const ExternalLink = ({
	href,
	node: _node,
	target: _target,
	children,
	...props
}: ExternalLinkProps) => {
	const handleClick = useCallback(
		(event: React.MouseEvent<HTMLAnchorElement>) => {
			if (!href || href === "streamdown:incomplete-link") return;
			event.preventDefault();
			openExternalUrl(href);
		},
		[href],
	);

	return (
		<a
			href={href}
			className="wrap-anywhere font-medium text-primary underline"
			{...props}
			onClick={handleClick}
		>
			{children}
		</a>
	);
};
