"use client";

import {
	ChevronDown,
	ChevronRight,
	ChevronUp,
	Replace,
	ReplaceAll,
	X,
} from "lucide-react";
import type { SlateEditor, TRange } from "platejs";
import { RangeApi } from "platejs";
import { useEditorRef, useEditorSelector } from "platejs/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	ActiveSearchHighlightPlugin,
	FindReplacePlugin,
	findSearchMatches,
} from "@/components/editor/plugins/find-replace-kit";
import { Button } from "@/components/ui/button";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";

/** All six bar buttons are the same ghost icon button with a bottom tooltip. */
function IconAction({
	label,
	icon,
	onClick,
	disabled,
	"aria-expanded": ariaExpanded,
}: {
	label: string;
	icon: ReactNode;
	onClick: () => void;
	disabled?: boolean;
	"aria-expanded"?: boolean;
}) {
	return (
		<Tooltip>
			<TooltipTrigger asChild>
				<Button
					type="button"
					size="icon-xs"
					variant="ghost"
					aria-label={label}
					aria-expanded={ariaExpanded}
					disabled={disabled}
					onClick={onClick}
				>
					{icon}
				</Button>
			</TooltipTrigger>
			<TooltipContent side="bottom">{label}</TooltipContent>
		</Tooltip>
	);
}

function scrollToMatch(editor: SlateEditor, match: TRange) {
	try {
		editor.api
			.toDOMRange(match)
			?.startContainer.parentElement?.scrollIntoView({ block: "center" });
	} catch {
		// Match not rendered yet; navigation stays usable.
	}
}

function replaceRange(editor: SlateEditor, range: TRange, text: string) {
	if (text) editor.tf.insertText(text, { at: range });
	else editor.tf.delete({ at: range });
}

export function FindReplaceBar({
	focusTick,
	onClose,
}: {
	/** Bump to refocus (and prefill from selection) while already open. */
	focusTick: number;
	onClose: () => void;
}) {
	const editor = useEditorRef();
	const { t } = useTranslation("editor");
	const [query, setQuery] = useState("");
	const [replacement, setReplacement] = useState("");
	const [showReplace, setShowReplace] = useState(false);
	const [activeIndex, setActiveIndex] = useState(0);
	const searchInputRef = useRef<HTMLInputElement>(null);

	// Recompute matches on every editor change while the bar is open.
	const matches = useEditorSelector(
		(e) => findSearchMatches(e, query),
		[query],
	);
	const index = matches.length ? Math.min(activeIndex, matches.length - 1) : -1;

	useEffect(() => {
		editor.setOption(FindReplacePlugin, "search", query);
		editor.setOption(
			ActiveSearchHighlightPlugin,
			"activeMatch",
			index >= 0 ? matches[index] : null,
		);
		editor.api.redecorate();
	}, [editor, query, matches, index]);

	useEffect(
		() => () => {
			editor.setOption(FindReplacePlugin, "search", "");
			editor.setOption(ActiveSearchHighlightPlugin, "activeMatch", null);
			editor.api.redecorate();
		},
		[editor],
	);

	// biome-ignore lint/correctness/useExhaustiveDependencies: focusTick is the trigger
	useEffect(() => {
		const selection = editor.selection;
		if (selection && RangeApi.isExpanded(selection)) {
			const selected = editor.api.string(selection);
			if (selected && !selected.includes("\n")) setQuery(selected);
		}
		searchInputRef.current?.focus();
		searchInputRef.current?.select();
	}, [focusTick]);

	const scrolledQueryRef = useRef("");
	useEffect(() => {
		if (!query) {
			scrolledQueryRef.current = "";
			return;
		}
		if (matches.length && scrolledQueryRef.current !== query) {
			scrolledQueryRef.current = query;
			setActiveIndex(0);
			scrollToMatch(editor, matches[0]);
		}
	}, [editor, query, matches]);

	const goTo = (target: number) => {
		if (!matches.length) return;
		const next = (target + matches.length) % matches.length;
		setActiveIndex(next);
		scrollToMatch(editor, matches[next]);
	};

	const replaceCurrent = () => {
		if (index < 0) return;
		replaceRange(editor, matches[index], replacement);
		const next = findSearchMatches(editor, query);
		if (!next.length) return;
		// A replacement containing the query re-matches in place; skip past it.
		const stillMatches = replacement
			.toLowerCase()
			.includes(query.toLowerCase());
		const nextIndex =
			((stillMatches ? index + 1 : index) + next.length) % next.length;
		setActiveIndex(nextIndex);
		scrollToMatch(editor, next[nextIndex]);
	};

	const replaceAll = () => {
		if (!matches.length) return;
		editor.tf.withoutNormalizing(() => {
			for (const match of [...matches].reverse()) {
				replaceRange(editor, match, replacement);
			}
		});
	};

	const handleBarKeyDown = (event: React.KeyboardEvent) => {
		if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
			event.preventDefault();
			searchInputRef.current?.focus();
			searchInputRef.current?.select();
		} else if (event.key === "Escape") {
			event.preventDefault();
			onClose();
		}
	};

	return (
		<TooltipProvider delayDuration={200}>
			{/** biome-ignore lint/a11y/noStaticElementInteractions: keyboard shortcuts for the contained inputs */}
			<div
				className="absolute top-2 right-4 z-30 rounded-lg border border-border/80 bg-background/95 p-1 shadow-md backdrop-blur-sm"
				onKeyDown={handleBarKeyDown}
			>
				<div className="flex items-center gap-1">
					<IconAction
						label={t("findReplace.toggleReplace")}
						aria-expanded={showReplace}
						icon={
							showReplace ? (
								<ChevronDown className="size-3.5" />
							) : (
								<ChevronRight className="size-3.5" />
							)
						}
						onClick={() => setShowReplace((v) => !v)}
					/>
					<input
						ref={searchInputRef}
						type="text"
						className="w-44 bg-transparent text-xs outline-none"
						placeholder={t("findReplace.searchPlaceholder")}
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Enter") {
								e.preventDefault();
								goTo(e.shiftKey ? index - 1 : index + 1);
							}
						}}
					/>
					<span className="min-w-11 shrink-0 px-1 text-center text-muted-foreground text-xs tabular-nums">
						{query
							? matches.length
								? `${index + 1}/${matches.length}`
								: t("findReplace.noResults")
							: ""}
					</span>
					<IconAction
						label={t("findReplace.prev")}
						icon={<ChevronUp className="size-3.5" />}
						disabled={!matches.length}
						onClick={() => goTo(index - 1)}
					/>
					<IconAction
						label={t("findReplace.next")}
						icon={<ChevronDown className="size-3.5" />}
						disabled={!matches.length}
						onClick={() => goTo(index + 1)}
					/>
					<IconAction
						label={t("findReplace.close")}
						icon={<X className="size-3.5" />}
						onClick={onClose}
					/>
				</div>
				{showReplace ? (
					<div className="mt-1 flex items-center gap-1 pl-7">
						<input
							type="text"
							className="w-44 bg-transparent text-xs outline-none"
							placeholder={t("findReplace.replacePlaceholder")}
							value={replacement}
							onChange={(e) => setReplacement(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") {
									e.preventDefault();
									replaceCurrent();
								}
							}}
						/>
						<IconAction
							label={t("findReplace.replace")}
							icon={<Replace className="size-3.5" />}
							disabled={index < 0}
							onClick={replaceCurrent}
						/>
						<IconAction
							label={t("findReplace.replaceAll")}
							icon={<ReplaceAll className="size-3.5" />}
							disabled={!matches.length}
							onClick={replaceAll}
						/>
					</div>
				) : null}
			</div>
		</TooltipProvider>
	);
}
