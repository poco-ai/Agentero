"use client";

import { Copy, Download } from "lucide-react";
import {
	type ComponentPropsWithoutRef,
	isValidElement,
	type ReactNode,
	useCallback,
	useMemo,
} from "react";
import { useTranslation } from "react-i18next";
import type { BundledLanguage } from "shiki";
import { CodeBlockContent } from "@/components/agent/rendering/code-block";
import { Button } from "@/components/ui/button";
import {
	CodeBlock,
	CodeBlockActions,
	CodeBlockHeader,
	CodeBlockTitle,
} from "@/components/ui/code-block";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { cn } from "@/lib/core/utils";

export function downloadText(filename: string, text: string) {
	const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	document.body.appendChild(a);
	a.click();
	document.body.removeChild(a);
	URL.revokeObjectURL(url);
}

function extractText(node: ReactNode): string {
	if (node == null || typeof node === "boolean") return "";
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(extractText).join("");
	if (isValidElement(node)) {
		const props = node.props as { children?: ReactNode };
		return extractText(props.children);
	}
	return "";
}

function extractLanguage(className?: string): string {
	const match = className?.match(/language-([^\s]+)/);
	return match?.[1] ?? "";
}

const LANGUAGE_EXTENSIONS: Record<string, string> = {
	typescript: "ts",
	javascript: "js",
	tsx: "tsx",
	jsx: "jsx",
	python: "py",
	json: "json",
	rust: "rs",
	go: "go",
	markdown: "md",
	md: "md",
	html: "html",
	css: "css",
	scss: "scss",
	shell: "sh",
	bash: "sh",
	sh: "sh",
	zsh: "sh",
	yaml: "yml",
	yml: "yml",
	toml: "toml",
	sql: "sql",
	text: "txt",
	plaintext: "txt",
	txt: "txt",
};

function extensionFor(language: string): string {
	if (!language) return "txt";
	const mapped = LANGUAGE_EXTENSIONS[language.toLowerCase()];
	if (mapped) return mapped;
	return /^[a-z0-9.+_-]+$/i.test(language) ? language : "txt";
}

type PlainCodeBlockProps = ComponentPropsWithoutRef<"code"> & {
	node?: unknown;
};

/**
 * Streamdown fenced-code renderer aligned with {@link PlainTable}:
 * hover copy / download, no outer card chrome, no fullscreen.
 */
export function PlainCodeBlock({
	children,
	className,
	node: _node,
	...props
}: PlainCodeBlockProps) {
	const isInline = !("data-block" in props);
	if (isInline) {
		return (
			<code
				className={cn(
					"rounded bg-muted px-1.5 py-0.5 font-mono text-sm",
					className,
				)}
				data-streamdown="inline-code"
				{...props}
			>
				{children}
			</code>
		);
	}

	const language = extractLanguage(className);
	const code = extractText(children).replace(/\n$/, "");

	return <PlainCodeBlockView code={code} language={language} />;
}

function PlainCodeBlockView({
	code,
	language,
}: {
	code: string;
	language: string;
}) {
	const { t } = useTranslation("aiElements");
	const lang = (language || "text") as BundledLanguage;

	const filename = useMemo(() => `code.${extensionFor(language)}`, [language]);

	const handleCopy = useCallback(() => {
		void copyTextToClipboard(code, {
			successMessage: t("code.copy"),
		});
	}, [code, t]);

	const handleDownload = useCallback(() => {
		downloadText(filename, code);
	}, [code, filename]);

	const iconButtonClass =
		"size-7 opacity-70 hover:opacity-100 focus-visible:opacity-100";
	const label = (language || "text").toLowerCase();

	return (
		<CodeBlock className="group/code my-4 rounded-md bg-background">
			<CodeBlockHeader className="h-8 justify-between border-b border-border/60 bg-muted/30 px-2.5 pt-0">
				<CodeBlockTitle
					className="font-mono text-[11px] lowercase leading-none text-muted-foreground"
					title={label}
				>
					{label}
				</CodeBlockTitle>
				<CodeBlockActions
					className={cn(
						"my-0 mr-0 gap-0.5",
						"opacity-0 transition-opacity group-hover/code:opacity-100",
						"focus-within:opacity-100 pointer-coarse:opacity-100",
					)}
				>
					<TooltipProvider>
						{[
							{
								key: "copy",
								label: t("code.copy"),
								Icon: Copy,
								onClick: handleCopy,
							},
							{
								key: "download",
								label: t("code.download"),
								Icon: Download,
								onClick: handleDownload,
							},
						].map(({ key, label: actionLabel, Icon, onClick }) => (
							<Tooltip key={key}>
								<TooltipTrigger asChild>
									<Button
										type="button"
										variant="ghost"
										size="icon"
										className={iconButtonClass}
										aria-label={actionLabel}
										onClick={onClick}
									>
										<Icon className="size-4" />
									</Button>
								</TooltipTrigger>
								<TooltipContent>
									<p>{actionLabel}</p>
								</TooltipContent>
							</Tooltip>
						))}
					</TooltipProvider>
				</CodeBlockActions>
			</CodeBlockHeader>
			<CodeBlockContent code={code} language={lang} showLineNumbers={false} />
		</CodeBlock>
	);
}
