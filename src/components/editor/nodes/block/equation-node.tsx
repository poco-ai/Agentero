"use client";

import { useEquationElement, useEquationInput } from "@platejs/math/react";
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
import { Button } from "@/components/ui/button";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/core/utils";

const katexOptions = (displayMode: boolean) => ({
	displayMode,
	errorColor: "#cc0000",
	fleqn: false,
	leqno: false,
	output: "htmlAndMathml" as const,
	strict: "warn" as const,
	throwOnError: false,
	trust: false,
});

const Textarea = React.forwardRef<
	HTMLTextAreaElement,
	React.ComponentProps<"textarea">
>((props, ref) => <textarea ref={ref} {...props} />);
Textarea.displayName = "EquationTextarea";

const EquationInput = createPrimitiveComponent(Textarea)({
	propsHook: useEquationInput,
});

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

export function EquationElement(props: PlateElementProps<TEquationElement>) {
	const selected = useSelected();
	const [open, setOpen] = React.useState(false);
	const katexRef = React.useRef<HTMLDivElement | null>(null);

	useEquationElement({
		element: props.element,
		katexRef,
		options: katexOptions(true),
	});

	return (
		<PlateElement className="my-1" {...props}>
			<Popover open={open} onOpenChange={setOpen} modal={false}>
				<PopoverTrigger asChild>
					<button
						type="button"
						className={cn(
							"group flex w-full cursor-pointer select-none items-center justify-center rounded-sm hover:bg-primary/10 data-[selected=true]:bg-primary/10",
							props.element.texExpression.length === 0
								? "bg-muted p-3"
								: "px-2 py-1",
						)}
						data-selected={selected}
						contentEditable={false}
					>
						{props.element.texExpression.length > 0 ? (
							<span ref={katexRef} />
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
}

export function InlineEquationElement(
	props: PlateElementProps<TEquationElement>,
) {
	const selected = useSelected();
	const [open, setOpen] = React.useState(false);
	const katexRef = React.useRef<HTMLDivElement | null>(null);

	useEquationElement({
		element: props.element,
		katexRef,
		options: katexOptions(false),
	});

	return (
		<PlateElement
			{...props}
			className="mx-0.5 inline-block select-none rounded-sm"
		>
			<Popover open={open} onOpenChange={setOpen} modal={false}>
				<PopoverTrigger asChild>
					<span
						className={cn(
							"cursor-pointer rounded-sm px-1 hover:bg-primary/10",
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
								"font-mono leading-none",
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
}
