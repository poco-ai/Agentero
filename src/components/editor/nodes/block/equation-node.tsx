"use client";

import { useEquationInput } from "@platejs/math/react";
import { CornerDownLeftIcon, RadicalIcon } from "lucide-react";
import type { TEquationElement } from "platejs";
import {
	createPrimitiveComponent,
	PlateElement,
	type PlateElementProps,
	useEditorRef,
	useElement,
	useReadOnly,
	useSelected,
} from "platejs/react";
import * as React from "react";
import { memo, useEffect } from "react";
import { useMarkdownExportMode } from "@/components/editor/markdown-export-mode-context";
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { useInView } from "@/hooks/use-in-view";
import { cn } from "@/lib/core/utils";
import { renderKatexToElement } from "@/lib/math/katex-cache";

const inlineKatexOptions: katex.KatexOptions = {
	displayMode: false,
	errorColor: "#cc0000",
	fleqn: false,
	leqno: false,
	output: "htmlAndMathml",
	strict: "warn",
	throwOnError: false,
	trust: false,
};

const displayKatexOptions: katex.KatexOptions = {
	...inlineKatexOptions,
	displayMode: true,
};

const Textarea = React.forwardRef<
	HTMLTextAreaElement,
	React.ComponentProps<"textarea">
>((props, ref) => <textarea ref={ref} {...props} />);
Textarea.displayName = "EquationTextarea";

const EquationInput = createPrimitiveComponent(Textarea)({
	propsHook: useEquationInput,
});

function useCachedEquationElement({
	texExpression,
	katexRef,
	options,
	enabled,
	preserveHeight = false,
	preserveBox = false,
}: {
	texExpression: string;
	katexRef: React.RefObject<HTMLElement | null>;
	options: katex.KatexOptions;
	enabled: boolean;
	preserveHeight?: boolean;
	preserveBox?: boolean;
}) {
	// Footprint of the last render. Eviction must not change the box: a display
	// formula collapsing would change the document height, and an inline one
	// changing width would re-wrap its line — either way every element after it
	// moves, which drags other formulas across their in-view thresholds and makes
	// the document shake.
	const boxRef = React.useRef({ width: 0, height: 0 });

	// biome-ignore lint/correctness/useExhaustiveDependencies: katexRef is a stable DOM container; only the TeX source should trigger re-render.
	useEffect(() => {
		const container = katexRef.current;
		if (!container) return;
		if (!enabled) {
			// Eviction is the whole point of `keepAlive: false`: a rendered KaTeX
			// formula is hundreds of nodes, and a math-heavy note that has been
			// scrolled through would otherwise keep every one of them in the DOM
			// forever, making each later style/layout pass cost hundreds of ms.
			if (preserveBox) {
				// `min-width` does nothing on a non-replaced inline box, so the
				// placeholder is made a sized inline-block instead.
				container.style.display = "inline-block";
				container.style.width = `${boxRef.current.width}px`;
				container.style.height = `${boxRef.current.height}px`;
			} else if (preserveHeight) {
				container.style.minHeight = `${boxRef.current.height > 0 ? boxRef.current.height : 64}px`;
			}
			container.replaceChildren();
			return;
		}
		container.style.display = "";
		container.style.width = "";
		container.style.height = "";
		container.style.minHeight = "";
		renderKatexToElement(texExpression, options, container);
		const rect = container.getBoundingClientRect();
		boxRef.current = { width: rect.width, height: rect.height };
	}, [enabled, texExpression, options]);
}

function EquationPopoverContent({
	isInline,
	open,
	setOpen,
	placeholder,
}: {
	isInline: boolean;
	open: boolean;
	setOpen: (open: boolean) => void;
	placeholder: string;
}) {
	const editor = useEditorRef();
	const readOnly = useReadOnly();
	const element = useElement<TEquationElement>();

	if (readOnly) return null;

	const onClose = () => {
		setOpen(false);
		editor.tf.select(element, { focus: true, next: isInline });
	};

	return (
		<PopoverContent
			className="flex gap-2"
			onEscapeKeyDown={(e) => e.preventDefault()}
			contentEditable={false}
		>
			<EquationInput
				className="agentero-scroll max-h-[50vh] grow resize-none rounded-md border bg-transparent p-2 text-sm outline-none"
				state={{ isInline, open, onClose }}
				placeholder={placeholder}
				autoFocus
			/>
			<Button variant="secondary" className="px-3" onClick={onClose}>
				<CornerDownLeftIcon className="size-3.5" />
			</Button>
		</PopoverContent>
	);
}

function equationPropsEqual(
	prev: PlateElementProps<TEquationElement>,
	next: PlateElementProps<TEquationElement>,
): boolean {
	return (
		prev.element.texExpression === next.element.texExpression &&
		prev.element.type === next.element.type
	);
}

export const EquationElement = memo(function EquationElement(
	props: PlateElementProps<TEquationElement>,
) {
	const selected = useSelected();
	const [open, setOpen] = React.useState(false);
	const katexRef = React.useRef<HTMLDivElement | null>(null);
	const exportMode = useMarkdownExportMode();
	// Same reasoning as the inline element: a display formula is hundreds of
	// nodes, so scrolled-past ones must give theirs back.
	const inView = useInView(katexRef, {
		enabled: !exportMode,
		keepAlive: false,
		rootMargin: "1200px 0px",
	});

	useCachedEquationElement({
		texExpression: props.element.texExpression,
		katexRef,
		options: displayKatexOptions,
		enabled: inView,
		// Display formulas are tall; collapsing them on eviction would change the
		// document height and shift the scroll.
		preserveHeight: true,
	});

	return (
		<PlateElement
			{...props}
			className="my-2 block w-full min-w-0 rounded-sm hover:bg-primary/10 data-[selected=true]:bg-primary/10"
			data-selected={selected}
		>
			<Popover open={open} onOpenChange={setOpen} modal={false}>
				<PopoverTrigger asChild>
					<button
						type="button"
						className={cn(
							"group flex w-full min-w-0 cursor-pointer select-none items-stretch justify-center rounded-sm",
							props.element.texExpression.length === 0
								? "bg-muted p-3"
								: "px-2 py-2",
						)}
						contentEditable={false}
					>
						{props.element.texExpression.length > 0 ? (
							<div
								ref={katexRef}
								className="agentero-scroll-both agentero-scroll-x-only w-full min-w-0 overflow-x-auto overflow-y-hidden py-1 text-center [&_.katex-display]:my-0 [&_.katex-display]:min-w-max"
							/>
						) : (
							<span className="flex h-7 items-center gap-2 text-muted-foreground text-sm">
								<RadicalIcon className="size-5 text-muted-foreground/80" />
								<span>Add a TeX equation</span>
							</span>
						)}
					</button>
				</PopoverTrigger>
				<EquationPopoverContent
					isInline={false}
					open={open}
					setOpen={setOpen}
					placeholder="E = mc^2"
				/>
			</Popover>
			{props.children}
		</PlateElement>
	);
}, equationPropsEqual);

export const InlineEquationElement = memo(function InlineEquationElement(
	props: PlateElementProps<TEquationElement>,
) {
	const selected = useSelected();
	const [open, setOpen] = React.useState(false);
	const katexRef = React.useRef<HTMLSpanElement | null>(null);
	// Observed instead of `katexRef`: KaTeX is written into the katex span
	// imperatively, so React must never reconcile its children. The measured
	// element is the wrapper, which carries the size placeholder while deferred.
	const wrapperRef = React.useRef<HTMLSpanElement | null>(null);

	// Inline formulas are the reason a math-heavy note stalls on resize: KaTeX
	// expands each one into tens to hundreds of spans, so ~5600 inline formulas
	// put ~200k nodes in the DOM and every style/layout pass then costs hundreds
	// of milliseconds. Only the equations near the viewport stay expanded; an
	// evicted one keeps its rendered footprint so the line does not re-wrap.
	const exportMode = useMarkdownExportMode();
	// `keepAlive: false`: the node count is the cost, so a formula that scrolls far
	// off screen has to give its nodes back. The wide rootMargin keeps that churn
	// well outside the viewport.
	const inView = useInView(wrapperRef, {
		enabled: !exportMode,
		keepAlive: false,
		rootMargin: "1200px 0px",
	});
	useCachedEquationElement({
		texExpression: props.element.texExpression,
		katexRef,
		options: inlineKatexOptions,
		enabled: inView,
		preserveBox: true,
	});

	return (
		<PlateElement
			{...props}
			className="mx-0.5 inline-flex max-w-full select-none items-baseline rounded-sm align-baseline"
		>
			<Popover open={open} onOpenChange={setOpen} modal={false}>
				<PopoverTrigger asChild>
					<span
						ref={wrapperRef}
						className={cn(
							"inline-flex max-w-full cursor-pointer items-baseline rounded-sm px-1 py-0.5 align-baseline hover:bg-primary/10",
							selected && "bg-primary/10",
							props.element.texExpression.length === 0 &&
								"text-muted-foreground",
						)}
						contentEditable={false}
					>
						<span
							ref={katexRef}
							className={cn(
								props.element.texExpression.length === 0 && "hidden",
								"min-w-0 max-w-full font-mono leading-normal",
							)}
						/>
						{props.element.texExpression.length === 0 && (
							<span className="inline-flex items-center gap-1">
								<RadicalIcon className="size-4" />
								equation
							</span>
						)}
					</span>
				</PopoverTrigger>
				<EquationPopoverContent
					isInline
					open={open}
					setOpen={setOpen}
					placeholder="E = mc^2"
				/>
			</Popover>
			{props.children}
		</PlateElement>
	);
}, equationPropsEqual);
