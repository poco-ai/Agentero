"use client";

import {
	type ClipboardEvent,
	type FormEvent,
	forwardRef,
	type HTMLAttributes,
	type KeyboardEvent,
	type MouseEvent,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useRef,
} from "react";
import { useTranslation } from "react-i18next";
import { usePromptInputAttachments } from "@/components/agent/composer/prompt-input";
import { useImeGuard } from "@/hooks/use-ime-guard";
import { AGENT_COMPOSER_INPUT_ATTR } from "@/lib/agent/composer-focus";
import {
	parseInlineTokenParts,
	stripInlineTokens,
} from "@/lib/agent/composer-inline-tokens";
import { decideComposerExternalValueSync } from "@/lib/agent/composer-sync";
import type { PdfVisualDraft } from "@/lib/agent/visual-context-store";
import { filesFromDataTransfer } from "@/lib/core/file-accept";
import { isImeKeyboardEvent } from "@/lib/core/ime";
import { cn } from "@/lib/core/utils";

import {
	CARET_PAD,
	CHIP_ATTR,
	chipToken,
	deleteChipElement,
	findChipAfter,
	findChipBefore,
	placeCaretAfter,
	placeCaretAtEnd,
	placeCaretAtSerializedOffset,
	renderChip,
	serializedOffset,
	serializeEditor,
	visualReferenceSnippet,
} from "./composer-inline-dom";

export type ComposerInlineInputHandle = {
	/**
	 * Insert an inline token and focus the field.
	 * @param atEnd - when true, append to the end of the draft instead of the
	 *   current caret position.
	 */
	insertAtCursor: (token: string, atEnd?: boolean) => void;
	/** Return the underlying contenteditable element. */
	getEditorElement: () => HTMLElement | null;
	/**
	 * Serialized caret from the last time the selection was inside the field.
	 * Survives focus moving to the PDF or note that triggered Add to chat.
	 */
	getCaretOffset: () => number | null;
	/**
	 * After the next controlled render of `value`, put the caret at `offset`
	 * instead of jumping to the end.
	 */
	setPendingCaret: (offset: number, value: string) => void;
};

export type ComposerInlineInputProps = {
	value: string;
	onValueChange: (text: string) => void;
	onKeyDown?: (event: KeyboardEvent<HTMLDivElement>) => void;
	disabled?: boolean;
	compact?: boolean;
	placeholder?: string;
	autoFocus?: boolean;
	labelForPath: (path: string) => string;
	skillLabel: (skillId: string) => string;
	visualDrafts?: readonly PdfVisualDraft[];
	/** Hover a text-annotation reference. `leave` starts the card's close delay. */
	onSelectionPointer?: (
		phase: "enter" | "leave",
		id: string,
		anchor: HTMLElement,
	) => void;
	/** Hover a visual reference. `leave` starts the card's close delay. */
	onVisualPointer?: (
		phase: "enter" | "leave",
		id: string,
		anchor: HTMLElement,
	) => void;
	"aria-expanded"?: boolean | undefined;
	"aria-autocomplete"?: HTMLAttributes<HTMLDivElement>["aria-autocomplete"];
	"aria-controls"?: string | undefined;
	"aria-activedescendant"?: string | undefined;
	className?: string;
};

export const ComposerInlineInput = forwardRef<
	ComposerInlineInputHandle,
	ComposerInlineInputProps
>(
	(
		{
			value,
			onValueChange,
			onKeyDown,
			disabled,
			compact = false,
			placeholder,
			autoFocus,
			labelForPath,
			skillLabel,
			visualDrafts = [],
			onSelectionPointer,
			onVisualPointer,
			className,
			...aria
		},
		ref,
	) => {
		const { t } = useTranslation("agent");
		const attachments = usePromptInputAttachments();
		const editorRef = useRef<HTMLDivElement>(null);
		/** null until first paint so the initial `value` always hydrates into the DOM. */
		const lastValueRef = useRef<string | null>(null);
		const composingRef = useRef(false);
		const awaitingParentEchoRef = useRef(false);
		const { isBlockedByIme, isComposing, compositionProps } = useImeGuard();
		const renderedTokensRef = useRef<Set<string>>(new Set());
		const isFirstRenderRef = useRef(true);
		const caretOffsetRef = useRef<number | null>(null);
		const pendingCaretRef = useRef<{ offset: number; value: string } | null>(
			null,
		);

		const emitFromDom = useCallback(() => {
			const root = editorRef.current;
			if (!root) return;
			const next = serializeEditor(root);
			lastValueRef.current = next;
			awaitingParentEchoRef.current = true;
			onValueChange(next);
		}, [onValueChange]);

		const scrollEditorToBottom = useCallback(() => {
			const root = editorRef.current;
			if (!root || document.activeElement !== root) return;
			root.scrollTop = root.scrollHeight;
		}, []);

		const renderValue = useCallback(
			(text: string) => {
				const root = editorRef.current;
				if (!root) return;
				root.replaceChildren();
				const parts = parseInlineTokenParts(text);
				if (parts.length === 0) {
					return;
				}
				const nextTokens = new Set<string>();
				for (const part of parts) {
					if (part.type === "text") {
						if (!part.value) continue;
						const lines = part.value.split("\n");
						lines.forEach((line, index) => {
							if (index > 0) root.appendChild(document.createElement("br"));
							if (line) root.appendChild(document.createTextNode(line));
						});
						continue;
					}
					const token = chipToken(part);
					if (token) nextTokens.add(token);
					const isNew =
						!isFirstRenderRef.current &&
						Boolean(token && !renderedTokensRef.current.has(token));
					const chip = renderChip(part, {
						labelForPath,
						skillLabel,
						visualDrafts,
						t,
						isNew,
					});
					root.appendChild(chip);
					root.appendChild(document.createTextNode(CARET_PAD));
				}
				renderedTokensRef.current = nextTokens;
				isFirstRenderRef.current = false;
			},
			[labelForPath, skillLabel, t, visualDrafts],
		);

		useLayoutEffect(() => {
			const root = editorRef.current;
			const decision = decideComposerExternalValueSync({
				nextValue: value,
				lastKnownDomValue: lastValueRef.current,
				currentDomValue: root ? serializeEditor(root) : "",
				focused: Boolean(root && document.activeElement === root),
				composing: composingRef.current || isComposing,
				awaitingParentEcho: awaitingParentEchoRef.current,
			});
			if (decision === "skip") {
				awaitingParentEchoRef.current = false;
				return;
			}
			if (decision === "defer") return;
			awaitingParentEchoRef.current = false;
			lastValueRef.current = value;
			renderValue(value);
			const pending = pendingCaretRef.current;
			if (pending && pending.value === value && root) {
				pendingCaretRef.current = null;
				root.focus({ preventScroll: true });
				placeCaretAtSerializedOffset(root, pending.offset);
				caretOffsetRef.current = pending.offset;
				scrollEditorToBottom();
			} else if (root && document.activeElement === root) {
				placeCaretAtEnd(root);
				scrollEditorToBottom();
			}
		});

		useEffect(() => {
			if (!autoFocus) return;
			editorRef.current?.focus();
		}, [autoFocus]);

		useImperativeHandle(
			ref,
			() => ({
				getEditorElement: () => editorRef.current,
				getCaretOffset: () => caretOffsetRef.current,
				setPendingCaret: (offset: number, nextValue: string) => {
					pendingCaretRef.current = { offset, value: nextValue };
				},
				insertAtCursor: (token: string, atEnd = false) => {
					const root = editorRef.current;
					if (!root) return;
					root.focus();

					const selection = window.getSelection();
					let inserted: Node | null = null;

					// Render the token as a chip immediately so the user sees the
					// final card, not raw `{{sel:...}}` text.
					const parts = parseInlineTokenParts(token);
					if (parts.length === 1 && parts[0]?.type !== "text") {
						const chip = renderChip(parts[0], {
							labelForPath,
							skillLabel,
							visualDrafts,
							t,
							isNew: true,
						});
						inserted = chip;
					} else {
						inserted = document.createTextNode(token);
					}

					const pad = document.createTextNode(CARET_PAD);
					const hasValidRange =
						!atEnd &&
						selection &&
						selection.rangeCount > 0 &&
						root.contains(selection.getRangeAt(0).commonAncestorContainer);
					if (hasValidRange) {
						const range = selection.getRangeAt(0);
						range.deleteContents();
						range.insertNode(inserted);
						range.setStartAfter(inserted);
						range.insertNode(pad);
						placeCaretAfter(pad);
					} else {
						root.appendChild(inserted);
						root.appendChild(pad);
						placeCaretAfter(pad);
					}

					emitFromDom();
					scrollEditorToBottom();
				},
			}),
			[
				emitFromDom,
				labelForPath,
				scrollEditorToBottom,
				skillLabel,
				t,
				visualDrafts,
			],
		);

		const handleInput = (_event: FormEvent<HTMLDivElement>) => {
			emitFromDom();
			scrollEditorToBottom();
		};

		const handleCompositionStart = () => {
			composingRef.current = true;
			compositionProps.onCompositionStart();
		};

		const handleCompositionEnd = () => {
			composingRef.current = false;
			compositionProps.onCompositionEnd();
			emitFromDom();
			scrollEditorToBottom();
		};

		const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
			if (event.key === "Enter" && isBlockedByIme(event)) {
				return;
			}

			if (
				(event.key === "Backspace" || event.key === "Delete") &&
				!isComposing &&
				!isImeKeyboardEvent(event)
			) {
				const selection = window.getSelection();
				if (!selection || selection.rangeCount === 0) {
					onKeyDown?.(event);
					return;
				}

				// Range selection that touches one or more chips: delete the whole
				// touched chips atomically.
				if (!selection.isCollapsed) {
					const range = selection.getRangeAt(0);
					const root = editorRef.current;
					if (!root) {
						onKeyDown?.(event);
						return;
					}

					const touchedChips: HTMLElement[] = [];
					const walker = document.createTreeWalker(
						root,
						NodeFilter.SHOW_ELEMENT,
						{
							acceptNode: (node) => {
								const el = node as HTMLElement;
								if (!el.getAttribute(CHIP_ATTR)) return NodeFilter.FILTER_SKIP;
								return range.intersectsNode(el)
									? NodeFilter.FILTER_ACCEPT
									: NodeFilter.FILTER_SKIP;
							},
						},
					);
					while (walker.nextNode()) {
						touchedChips.push(walker.currentNode as HTMLElement);
					}

					if (touchedChips.length > 0) {
						event.preventDefault();
						const newRange = document.createRange();
						newRange.setStart(range.startContainer, range.startOffset);
						newRange.setEnd(range.endContainer, range.endOffset);

						// Extend range to fully cover chips at the boundaries.
						for (const chip of touchedChips) {
							const chipRange = document.createRange();
							chipRange.selectNode(chip);
							if (
								newRange.compareBoundaryPoints(
									Range.START_TO_START,
									chipRange,
								) > 0
							) {
								newRange.setStartBefore(chip);
							}
							if (
								newRange.compareBoundaryPoints(Range.END_TO_END, chipRange) < 0
							) {
								newRange.setEndAfter(chip);
							}
						}

						newRange.deleteContents();
						for (const chip of touchedChips) {
							if (chip.parentNode) chip.remove();
						}

						const caret = document.createRange();
						caret.setStart(newRange.startContainer, newRange.startOffset);
						caret.collapse(true);
						selection.removeAllRanges();
						selection.addRange(caret);
						emitFromDom();
						return;
					}
				}

				// Collapsed caret next to a chip.
				if (selection.isCollapsed) {
					const range = selection.getRangeAt(0);
					const root = editorRef.current;
					if (!root) {
						onKeyDown?.(event);
						return;
					}

					const found =
						event.key === "Backspace"
							? findChipBefore(root, range)
							: findChipAfter(root, range);
					if (found) {
						event.preventDefault();
						deleteChipElement(
							found.chip,
							found.pads,
							event.key === "Backspace" ? "before" : "after",
						);
						emitFromDom();
						return;
					}
				}
			}

			onKeyDown?.(event);
			if (event.defaultPrevented) return;

			if (event.key === "Enter" && !event.shiftKey) {
				event.preventDefault();
				const form = event.currentTarget.closest("form");
				const submitButton = form?.querySelector(
					'button[type="submit"]',
				) as HTMLButtonElement | null;
				if (submitButton?.disabled) return;
				form?.requestSubmit();
			}
		};

		const handlePaste = (event: ClipboardEvent<HTMLDivElement>) => {
			event.preventDefault();
			const files = filesFromDataTransfer(event.clipboardData);
			if (attachments.enabled && files.length > 0) {
				attachments.add(files);
				return;
			}
			const text = event.clipboardData.getData("text/plain");
			if (!text) return;
			document.execCommand("insertText", false, text);
			emitFromDom();
		};

		useEffect(() => {
			const onSelectionChange = () => {
				const root = editorRef.current;
				const selection = window.getSelection();
				if (!root || !selection || selection.rangeCount === 0) return;
				const range = selection.getRangeAt(0);
				if (!root.contains(range.startContainer)) return;
				caretOffsetRef.current = serializedOffset(
					root,
					range.startContainer,
					range.startOffset,
				);
			};
			document.addEventListener("selectionchange", onSelectionChange);
			return () =>
				document.removeEventListener("selectionchange", onSelectionChange);
		}, []);

		useEffect(() => {
			const root = editorRef.current;
			if (!root) return;
			for (const node of root.querySelectorAll<HTMLElement>(
				`[${CHIP_ATTR}="visual"]`,
			)) {
				const draft = visualDrafts.find(
					(item) => item.id === node.dataset.visualId,
				);
				const label = node.querySelector("[data-chip-label]");
				if (!label) continue;
				const pageLabel = t("composer.visualAnnotationPage", {
					page: draft?.page ?? 1,
				});
				const snippet = visualReferenceSnippet(draft, pageLabel);
				if (label.textContent !== snippet) label.textContent = snippet;
			}
		}, [t, visualDrafts]);

		const handleChipClick = (event: MouseEvent<HTMLDivElement>) => {
			const target = event.target as HTMLElement | null;
			const chip = target?.closest?.(`[${CHIP_ATTR}]`) as HTMLElement | null;
			if (!chip || !editorRef.current?.contains(chip)) return;
			const kind = chip.getAttribute(CHIP_ATTR);
			// Text and visual references stay; their hover cards own edit and delete.
			if (kind === "selection" || kind === "visual") return;
			event.preventDefault();
			event.stopPropagation();
			// Focus before changing the DOM. Focusing after setting the Range lets
			// WebView normalize the caret and discard the landing position.
			editorRef.current?.focus({ preventScroll: true });
			deleteChipElement(chip);
			emitFromDom();
		};

		const handleReferencePointer = (
			event: MouseEvent<HTMLDivElement>,
			phase: "enter" | "leave",
		) => {
			const target = event.target as HTMLElement | null;
			const chip = target?.closest?.(
				`[${CHIP_ATTR}="selection"], [${CHIP_ATTR}="visual"]`,
			) as HTMLElement | null;
			if (!chip || !editorRef.current?.contains(chip)) return;
			const kind = chip.getAttribute(CHIP_ATTR);
			if (phase === "leave") {
				const next = event.relatedTarget;
				if (next instanceof Node && chip.contains(next)) return;
				if (
					next instanceof Element &&
					next.closest(
						"[data-annotation-ui], [data-composer-chip='selection'], [data-composer-chip='visual']",
					)
				) {
					return;
				}
			}
			if (kind === "selection") {
				const id = chip.dataset.selectionId;
				if (id) onSelectionPointer?.(phase, id, chip);
				return;
			}
			if (kind === "visual") {
				const id = chip.dataset.visualId;
				if (id) onVisualPointer?.(phase, id, chip);
			}
		};

		const isVisuallyEmpty = parseInlineTokenParts(value).every(
			(part) =>
				part.type === "text" &&
				part.value.replaceAll(CARET_PAD, "").trim().length === 0,
		);

		return (
			<>
				{/* Keep PromptInput FormData happy; controlled submit prefers React state. */}
				<textarea
					name="message"
					className="sr-only"
					tabIndex={-1}
					readOnly
					aria-hidden
					value={stripInlineTokens(value)}
				/>
				<div
					className={cn(
						"relative flex min-h-0 flex-col",
						compact ? "min-w-0 flex-1" : "flex-1",
					)}
				>
					{isVisuallyEmpty && placeholder ? (
						<div
							aria-hidden
							className={cn(
								"pointer-events-none absolute inset-0 px-0 text-muted-foreground/80",
								compact
									? "py-0 text-sm leading-5"
									: "py-1 text-[15px] leading-5",
							)}
						>
							{placeholder}
						</div>
					) : null}
					{/* Contenteditable is required for inline chip DOM; not a plain textarea. */}
					{/* biome-ignore lint/a11y/useSemanticElements: chips must live inside the editable surface */}
					<div
						ref={editorRef}
						{...{ [AGENT_COMPOSER_INPUT_ATTR]: "" }}
						role="textbox"
						aria-multiline="true"
						tabIndex={disabled ? -1 : 0}
						contentEditable={!disabled}
						suppressContentEditableWarning
						data-slot="input-group-control"
						className={cn(
							"agentero-scroll relative min-h-0 overflow-y-auto px-0 text-foreground outline-none",
							compact
								? "h-6 max-h-none min-w-0 flex-1 py-0 text-sm leading-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
								: "min-h-0 flex-1 py-1 text-[15px] leading-5",
							disabled && "opacity-60",
							className,
						)}
						onInput={handleInput}
						onKeyDown={handleKeyDown}
						onPaste={handlePaste}
						onClick={handleChipClick}
						onMouseOver={(event) => handleReferencePointer(event, "enter")}
						onMouseOut={(event) => handleReferencePointer(event, "leave")}
						onCompositionStart={handleCompositionStart}
						onCompositionEnd={handleCompositionEnd}
						{...aria}
					/>
				</div>
			</>
		);
	},
);

ComposerInlineInput.displayName = "ComposerInlineInput";
