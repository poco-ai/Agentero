"use client";

import { XIcon } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { MOTION_MS } from "@/lib/core/motion";
import { cn } from "@/lib/core/utils";
import { sanitizeEmbeddedHtml } from "@/lib/markdown/html-sanitize";

export type HtmlPreviewState = {
	html: string;
	/** Bumped on every open so the panel body remounts on a new target. */
	key: number;
};

/**
 * In-editor HTML preview panel (#825).
 *
 * Clicking an `html_block` in a Markdown note reveals the block on the right
 * of the editor, clipped open from its anchored right edge. The panel is
 * intentionally kept inside the editor pane (not a Dockview panel): Dockview
 * never animates splits, and the preview belongs to the note being read.
 *
 * Content goes through the same `sanitizeEmbeddedHtml` as the inline block,
 * so scripts/styles stay stripped and iframes keep their sandbox.
 */
export function HtmlPreviewPanel({
	preview,
	onClose,
}: {
	preview: HtmlPreviewState | null;
	onClose: () => void;
}) {
	const { t } = useTranslation("editor");
	const reduceMotion = useReducedMotion();

	useEffect(() => {
		if (!preview) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.preventDefault();
				onClose();
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [preview, onClose]);

	return (
		<AnimatePresence>
			{preview ? (
				<motion.aside
					key="html-preview"
					aria-label={t("html.preview")}
					initial={
						reduceMotion
							? { opacity: 0 }
							: { clipPath: "inset(0 0 0 100%)", opacity: 0.6 }
					}
					animate={{ clipPath: "inset(0 0 0 0)", opacity: 1 }}
					exit={
						reduceMotion
							? { opacity: 0 }
							: { clipPath: "inset(0 0 0 100%)", opacity: 0.6 }
					}
					transition={
						reduceMotion
							? { duration: 0 }
							: { type: "spring", bounce: 0.12, duration: 0.34 }
					}
					className={cn(
						"absolute inset-y-0 right-0 z-30 flex w-[min(42rem,72%)] flex-col",
						"border-l bg-background shadow-overlay",
					)}
				>
					<motion.div
						className="flex h-10 shrink-0 items-center justify-between gap-2 border-b px-3"
						initial={reduceMotion ? false : { opacity: 0 }}
						animate={{ opacity: 1 }}
						transition={
							reduceMotion
								? { duration: 0 }
								: { delay: 0.05, duration: MOTION_MS.fast / 1000 }
						}
					>
						<span className="truncate font-medium text-muted-foreground text-xs uppercase tracking-wide">
							{t("html.preview")}
						</span>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="size-7 text-muted-foreground"
							title={t("html.closePreview")}
							aria-label={t("html.closePreview")}
							onClick={onClose}
						>
							<XIcon className="size-3.5" />
						</Button>
					</motion.div>
					<HtmlPreviewBody key={preview.key} html={preview.html} />
				</motion.aside>
			) : null}
		</AnimatePresence>
	);
}

function HtmlPreviewBody({ html }: { html: string }) {
	const rendered = useMemo(() => sanitizeEmbeddedHtml(html), [html]);
	if (!rendered) return null;
	return (
		<div className="agentero-scroll min-h-0 flex-1 overflow-auto p-4 text-sm">
			{/* biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized above */}
			<div dangerouslySetInnerHTML={{ __html: rendered }} />
		</div>
	);
}
