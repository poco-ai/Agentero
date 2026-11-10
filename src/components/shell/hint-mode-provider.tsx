import { type ReactNode, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useSettings } from "@/hooks/use-app-stores";
import {
	assignHintLabels,
	HINT_MODIFIER_KEYS,
	hintKeyFromEvent,
	matchHintLabel,
} from "@/lib/keyboard/hint-labels";
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
			if (event.repeat) return;
			const current = sessionRef.current;
			if (!current) {
				if (
					!enabledRef.current ||
					event.isComposing ||
					event.metaKey ||
					event.ctrlKey ||
					event.altKey ||
					isKeyboardInput(event.target) ||
					hintKeyFromEvent(event) !== "f" ||
					!selectionIsCollapsed(doc)
				) {
					return;
				}
				event.preventDefault();
				event.stopImmediatePropagation();
				enter();
				return;
			}
			// A held modifier types the label; it does not cancel the session.
			// Shift+A arrives as a Shift keydown followed by an "A" keydown, and
			// treating the first one as unknown input made every badge disappear.
			if (HINT_MODIFIER_KEYS.has(event.key)) return;
			if (event.metaKey || event.ctrlKey || event.altKey) {
				exit();
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				event.stopImmediatePropagation();
				exit();
				return;
			}
			// F is the hint-mode toggle. Reserve it while a session is open so a
			// second press dismisses the labels instead of being treated as a label
			// character.
			if (hintKeyFromEvent(event) === "f") {
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
			const key = hintKeyFromEvent(event);
			if (!key) {
				exit();
				return;
			}
			event.preventDefault();
			event.stopImmediatePropagation();
			const query = current.query + key;
			const match = matchHintLabel(query, current.labels);
			if (match.kind === "unique") {
				const target = current.targets[match.index]?.element;
				exit();
				if (!target?.isConnected) return;
				target.focus({ preventScroll: true });
				target.click();
				return;
			}
			// Unknown keys keep the current prefix so the labels stay readable.
			if (match.kind === "partial") setSession({ ...current, query });
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
		return () => {
			observer.disconnect();
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("scroll", onCancel, true);
			window.removeEventListener("resize", onCancel);
			window.removeEventListener("blur", onCancel);
			window.removeEventListener("pointerdown", onCancel, true);
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
							{session.targets.map((target, index) => {
								const label = session.labels[index];
								const matched = label.startsWith(session.query);
								// The typed prefix is already spent, keep the remaining key
								// characters as the only prominent part of the badge.
								const typed = matched ? session.query.length : 0;
								return (
									<span
										key={`${label}-${target.element.dataset.hint ?? index}`}
										className="absolute rounded border border-amber-500/80 bg-amber-200/95 px-1.5 py-0.5 font-mono font-semibold text-[11px] text-amber-950 tracking-wide shadow-sm dark:bg-amber-800/95 dark:text-amber-50"
										style={{
											opacity: matched ? 1 : 0.15,
											left: target.rect.left,
											top: target.rect.top,
										}}
									>
										{typed > 0 ? (
											<span className="text-amber-700/60 dark:text-amber-200/50">
												{label.slice(0, typed)}
											</span>
										) : null}
										{label.slice(typed)}
									</span>
								);
							})}
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
