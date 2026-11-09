import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useStore } from "zustand";
import {
	HoverCard,
	HoverCardContent,
	HoverCardTrigger,
} from "@/components/ui/hover-card";
import {
	annotationPdfAnchors,
	annotationStore,
} from "@/lib/agent/selection-annotations";
import { openAnnotationEditor } from "@/lib/agent/selection-chat-store";
import { resolveSelectionRange } from "@/lib/agent/selection-source";
import { toVaultRelative } from "@/lib/core/path";
import { vaultStore } from "@/lib/vault/store";

/** Geometry is measured from live source nodes, never a stale viewport position. */
export function AnnotationBadges() {
	const { t } = useTranslation(["viewer", "common"]);
	const binding = useStore(annotationStore, (s) => s.binding);
	const [positions, setPositions] = useState<
		Record<string, { x: number; y: number }>
	>({});
	useEffect(() => {
		// No quoted comment: nothing to position, so do not observe at all.
		const annotated = (binding?.selections ?? []).filter((selection) =>
			Boolean(selection.comment?.trim()),
		);
		if (!annotated.length) return;
		let frame = 0;
		const measure = () => {
			const next: typeof positions = {};
			for (const selection of annotated) {
				const range = resolveSelectionRange(selection);
				let rect: DOMRect | undefined;
				let source: Element | null = null;
				if (range?.startContainer.isConnected) {
					rect = Array.from(range.getClientRects())
						.filter((r) => r.width && r.height)
						.at(-1);
					source = range.endContainer.parentElement;
				}
				const pdf =
					annotationPdfAnchors.get(selection.id) ??
					(selection.origin === "pdf" &&
					selection.page &&
					selection.rects?.length
						? {
								documentId: "",
								page: selection.page,
								rect: selection.rects[selection.rects.length - 1],
							}
						: undefined);
				if (pdf) {
					const page = Array.from(
						document.querySelectorAll<HTMLElement>("[data-annotation-pdf]"),
					).find(
						(el) =>
							(el.dataset.annotationPdf === pdf.documentId ||
								(el.dataset.annotationSource &&
									toVaultRelative(
										vaultStore.getState().vaultPath,
										el.dataset.annotationSource,
									) === selection.sourcePath)) &&
							el.dataset.annotationPage === String(pdf.page),
					);
					if (page) {
						const box = page.getBoundingClientRect();
						rect = new DOMRect(
							box.left + pdf.rect.x * box.width,
							box.top + pdf.rect.y * box.height,
							pdf.rect.w * box.width,
							pdf.rect.h * box.height,
						);
						source = page;
					}
				}
				if (
					!rect ||
					!source ||
					rect.bottom < 0 ||
					rect.top > innerHeight ||
					rect.right < 0 ||
					rect.left > innerWidth
				)
					continue;
				// Virtualized and scroll-clipped content must not leave badges over other panes.
				let visible = true;
				for (
					let parent: Element | null = source;
					parent;
					parent = parent.parentElement
				) {
					const style = getComputedStyle(parent);
					if (
						/(auto|scroll|hidden|clip)/.test(
							style.overflow + style.overflowX + style.overflowY,
						)
					) {
						const box = parent.getBoundingClientRect();
						if (
							rect.bottom <= box.top ||
							rect.top >= box.bottom ||
							rect.right <= box.left ||
							rect.left >= box.right
						) {
							visible = false;
							break;
						}
					}
				}
				if (visible)
					next[selection.id] = {
						x: Math.min(innerWidth - 28, Math.max(2, rect.right - 4)),
						y: Math.max(2, rect.top - 19),
					};
			}
			setPositions((prev) =>
				JSON.stringify(prev) === JSON.stringify(next) ? prev : next,
			);
		};
		const schedule = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(measure);
		};
		schedule();
		const scrollListenerOptions: AddEventListenerOptions = {
			capture: true,
			passive: true,
		};
		window.addEventListener("scroll", schedule, scrollListenerOptions);
		window.addEventListener("resize", schedule);
		// Source edits, panel resizing and virtualization can move ranges without a window resize.
		// `characterData` is deliberately omitted: it fires on every keystroke in the
		// notes editor, and the next scroll/resize/structural change re-measures.
		const observer = new MutationObserver(schedule);
		const resize = new ResizeObserver(schedule);
		resize.observe(document.body);
		observer.observe(document.body, {
			childList: true,
			subtree: true,
		});
		for (const surface of document.querySelectorAll(
			"[data-selection-chat-source], [data-annotation-pdf]",
		)) {
			observer.observe(surface, {
				childList: true,
				subtree: true,
			});
			resize.observe(surface);
		}
		return () => {
			cancelAnimationFrame(frame);
			observer.disconnect();
			resize.disconnect();
			window.removeEventListener("scroll", schedule, scrollListenerOptions);
			window.removeEventListener("resize", schedule);
		};
	}, [binding]);
	return (
		<>
			{(binding?.selections ?? []).map((selection, index) => {
				// A plain quote has no comment to show or edit — no badge.
				if (!selection.comment?.trim()) return null;
				const pos = positions[selection.id];
				if (!pos) return null;
				return (
					<HoverCard key={selection.id} openDelay={150}>
						<HoverCardTrigger asChild>
							<button
								data-annotation-ui
								type="button"
								aria-label={`${t("common:edit")} ${index + 1}`}
								style={{ left: pos.x, top: pos.y }}
								className="fixed z-40 flex size-6 cursor-pointer items-center justify-center rounded-full rounded-bl-sm bg-blue-500 text-xs font-semibold text-white shadow-raised hover:bg-blue-600 focus-visible:ring-2 focus-visible:ring-ring"
								onPointerDown={(event) => event.preventDefault()}
								onClick={() => openAnnotationEditor(selection, pos)}
							>
								{index + 1}
							</button>
						</HoverCardTrigger>
						<HoverCardContent
							data-annotation-ui
							side="top"
							className="max-w-80 whitespace-pre-wrap break-words"
						>
							{selection.comment}
						</HoverCardContent>
					</HoverCard>
				);
			})}
		</>
	);
}
