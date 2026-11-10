import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/hooks/use-app-stores";
import { assignHintLabels, matchHintLabel } from "@/lib/keyboard/hint-labels";
import {
	collectHintTargets,
	type HintTarget,
} from "@/lib/keyboard/hint-targets";
import { isKeyboardInput, topKeyboardModal } from "@/lib/keyboard/ownership";

type HintSession = {
	targets: HintTarget[];
	labels: string[];
	query: string;
};

function selectionIsCollapsed(doc: Document): boolean {
	const selection = doc.defaultView?.getSelection();
	return !selection || selection.isCollapsed || !selection.toString().trim();
}

/** Global, ephemeral F-key target hints. Targets are scoped to this document. */
export function HintModeProvider({ children }: { children: ReactNode }) {
	const { t } = useTranslation("app");
	const enabled = useSettings((settings) => settings.hintModeEnabled);
	const [session, setSession] = useState<HintSession | null>(null);
	const [announcement, setAnnouncement] = useState("");
	const sessionRef = useRef(session);
	sessionRef.current = session;
	const enabledRef = useRef(enabled);
	enabledRef.current = enabled;

	useEffect(() => {
		if (!enabled) setSession(null);
	}, [enabled]);

	useEffect(() => {
		const doc = document;
		const exit = () => {
			if (!sessionRef.current) return;
			setSession(null);
			setAnnouncement("");
		};
		const enter = () => {
			const root = topKeyboardModal(doc) ?? doc.body;
			const targets = collectHintTargets(root);
			const labels = assignHintLabels(targets.length);
			setSession({ targets, labels, query: "" });
			setAnnouncement(t("navigator.hintTargets", { count: targets.length }));
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.isComposing || event.repeat) return;
			const current = sessionRef.current;
			if (
				current &&
				(isKeyboardInput(event.target) ||
					event.metaKey ||
					event.ctrlKey ||
					event.altKey)
			) {
				exit();
				return;
			}
			if (!current) {
				if (
					!enabledRef.current ||
					event.key !== "f" ||
					event.metaKey ||
					event.ctrlKey ||
					event.altKey ||
					isKeyboardInput(event.target) ||
					!selectionIsCollapsed(doc)
				) {
					return;
				}
				event.preventDefault();
				event.stopImmediatePropagation();
				enter();
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopImmediatePropagation();
				exit();
				return;
			}
			if (event.key === "Backspace") {
				event.preventDefault();
				event.stopImmediatePropagation();
				setSession({ ...current, query: current.query.slice(0, -1) });
				return;
			}
			if (!/^[a-z]$/i.test(event.key)) {
				exit();
				return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			const query = current.query + event.key.toLowerCase();
			const match = matchHintLabel(query, current.labels);
			if (match.kind === "unique") {
				const target = current.targets[match.index]?.element;
				exit();
				if (!target?.isConnected) return;
				target.focus({ preventScroll: true });
				target.click();
				return;
			}
			setSession({ ...current, query });
		};
		const onCancel = () => exit();
		const observer = new MutationObserver(() => {
			if (
				sessionRef.current?.targets.some(({ element }) => !element.isConnected)
			)
				exit();
		});
		observer.observe(doc.body, { childList: true, subtree: true });
		window.addEventListener("keydown", onKeyDown, true);
		window.addEventListener("scroll", onCancel, true);
		window.addEventListener("resize", onCancel);
		window.addEventListener("blur", onCancel);
		window.addEventListener("pointerdown", onCancel, true);
		window.addEventListener("focusin", onCancel, true);
		return () => {
			observer.disconnect();
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("scroll", onCancel, true);
			window.removeEventListener("resize", onCancel);
			window.removeEventListener("blur", onCancel);
			window.removeEventListener("pointerdown", onCancel, true);
			window.removeEventListener("focusin", onCancel, true);
		};
	}, [t]);

	return (
		<>
			{children}
			{session
				? createPortal(
						<div
							aria-hidden="true"
							className="pointer-events-none fixed inset-0 z-[var(--z-hint-overlay,999)]"
						>
							{session.targets.map((target, index) => (
								<span
									key={`${session.labels[index]}-${target.element.dataset.hint ?? index}`}
									className="absolute rounded border border-amber-500/80 bg-amber-200/95 px-1.5 py-0.5 font-mono font-semibold text-[11px] text-amber-950 shadow-sm dark:bg-amber-800/95 dark:text-amber-50"
									style={{
										opacity: session.labels[index].startsWith(session.query)
											? 1
											: 0.2,
										left: target.rect.left,
										top: target.rect.top,
									}}
								>
									{session.labels[index].toUpperCase()}
								</span>
							))}
						</div>,
						document.body,
					)
				: null}
			<div aria-live="polite" className="sr-only">
				{announcement}
			</div>
		</>
	);
}
