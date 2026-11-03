/** biome-ignore-all lint/suspicious/noArrayIndexKey: code lines and tokens are stateless and identified by their source position. */
"use client";

import { CheckIcon, CopyIcon } from "lucide-react";
import type { ComponentProps, HTMLAttributes } from "react";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BundledLanguage } from "shiki";
import { Button } from "@/components/ui/button";
import {
	CodeBlockActions,
	CodeBlockLine,
	CodeBlockContent as CodeBlockPre,
	CodeBlock as CodeBlockRoot,
} from "@/components/ui/code-block";
import { useHighlightedCode } from "@/hooks/use-highlighted-code";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { cn } from "@/lib/core/utils";

const CodeContext = createContext("");

export function CodeBlockContent({
	code,
	language,
	showLineNumbers = false,
	compact = false,
	wrap = false,
	className,
}: {
	code: string;
	language: BundledLanguage;
	showLineNumbers?: boolean;
	compact?: boolean;
	wrap?: boolean;
	className?: string;
}) {
	const lines = useHighlightedCode(code, language);
	return (
		<CodeBlockPre
			lineNumbers={showLineNumbers}
			wrap={wrap}
			className={cn(
				"m-0",
				compact && "min-w-0 flex-1 px-3 py-2 text-xs",
				className,
			)}
		>
			{lines.map((line, index) => (
				<CodeBlockLine key={`line-${index}`}>{line}</CodeBlockLine>
			))}
		</CodeBlockPre>
	);
}

export function CodeBlock({
	code,
	language,
	showLineNumbers,
	children,
	...props
}: HTMLAttributes<HTMLDivElement> & {
	code: string;
	language: BundledLanguage;
	showLineNumbers?: boolean;
}) {
	return (
		<CodeContext.Provider value={code}>
			<CodeBlockRoot {...props}>
				{children}
				<CodeBlockContent
					code={code}
					language={language}
					showLineNumbers={showLineNumbers}
				/>
			</CodeBlockRoot>
		</CodeContext.Provider>
	);
}

export type CodeBlockCopyButtonProps = ComponentProps<typeof Button> & {
	onCopy?: () => void;
	onError?: (error: Error) => void;
	timeout?: number;
};

export function CodeBlockCopyButton({
	onCopy,
	onError,
	timeout = 2000,
	children,
	...props
}: CodeBlockCopyButtonProps) {
	const { t } = useTranslation("aiElements");
	const code = useContext(CodeContext);
	const [copied, setCopied] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	useEffect(() => () => clearTimeout(timer.current), []);
	return (
		<Button
			type="button"
			size="icon"
			variant="ghost"
			aria-label={t("code.copy")}
			onClick={async () => {
				if (copied) return;
				if (!(await copyTextToClipboard(code))) {
					onError?.(new Error("Clipboard API not available"));
					return;
				}
				setCopied(true);
				onCopy?.();
				timer.current = setTimeout(() => setCopied(false), timeout);
			}}
			{...props}
		>
			{children ?? (copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />)}
		</Button>
	);
}

export type CompactCodeBlockProps = Omit<
	HTMLAttributes<HTMLDivElement>,
	"children"
> & {
	code: string;
	language: BundledLanguage;
	wrap?: boolean;
	copyButtonProps?: Omit<CodeBlockCopyButtonProps, "children">;
};

export function CompactCodeBlock({
	code,
	language,
	className,
	wrap,
	copyButtonProps,
	...props
}: CompactCodeBlockProps) {
	return (
		<CodeContext.Provider value={code}>
			<CodeBlockRoot
				size="sm"
				className={cn("flex-row items-stretch", className)}
				{...props}
			>
				<CodeBlockContent code={code} language={language} compact wrap={wrap} />
				<CodeBlockActions className="static! m-0! items-center border-l bg-muted/30 px-0.5 opacity-100!">
					<CodeBlockCopyButton {...copyButtonProps} />
				</CodeBlockActions>
			</CodeBlockRoot>
		</CodeContext.Provider>
	);
}
