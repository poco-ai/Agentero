// biome-ignore-all lint/security/noDangerouslySetInnerHtml: Mermaid strict mode produces the SVG markup shown in this preview.
"use client";

import { common } from "lowlight";
import { CheckIcon, CopyIcon } from "lucide-react";
import { NodeApi, type TCodeBlockElement, type TCodeSyntaxLeaf } from "platejs";
import {
	PlateElement,
	type PlateElementProps,
	PlateLeaf,
	type PlateLeafProps,
	useEditorRef,
	useElement,
	useReadOnly,
} from "platejs/react";
import * as React from "react";
import { useTranslation } from "react-i18next";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@/components/ui/command";
import {
	Popover,
	PopoverContent,
	PopoverTrigger,
} from "@/components/ui/popover";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { copyTextToClipboard } from "@/lib/core/clipboard";
import { cn } from "@/lib/core/utils";

// Mermaid is preserved as code-block metadata even though it is not included
// in lowlight's common syntax bundle.
const LANGUAGES = [...new Set([...Object.keys(common), "mermaid"])].sort();

/**
 * Languages that mean "no highlighting". Selecting one clears the persisted
 * `lang` (writes `undefined`) so the block serializes as a bare fenced block
 * rather than ```` ```plaintext ````, while still matching the "plain" intent.
 * lowlight treats both undefined and "plaintext" as a no-op (no decorations).
 */
const PLAIN_LANGS = new Set(["plaintext", "plain"]);

function CodeLanguageSelect() {
	const { t } = useTranslation("editor");
	const editor = useEditorRef();
	const readOnly = useReadOnly();
	const element = useElement<TCodeBlockElement>();
	const [open, setOpen] = React.useState(false);

	// Read-only / preview views don't expose the language picker; highlighting
	// still renders from the persisted `lang` attribute.
	if (readOnly) return null;

	// `lang: undefined` (no highlighting) is represented in the picker by the
	// `plaintext` option.
	const current = element.lang ?? "";
	const value = current ? current : "plaintext";
	const label = current ? current : t("codeBlock.plainText");

	const onSelect = (next: string) => {
		// Plain variants clear `lang` so the block serializes without a fence lang.
		const lang = PLAIN_LANGS.has(next) ? undefined : next;
		editor.tf.setNodes<TCodeBlockElement>({ lang }, { at: element });
		setOpen(false);
	};

	return (
		<div contentEditable={false}>
			<Popover open={open} onOpenChange={setOpen} modal={false}>
				<PopoverTrigger asChild>
					<button
						type="button"
						aria-label={t("codeBlock.languageLabel")}
						className={cn(
							"flex h-6 items-center rounded-md bg-background/80 px-1.5 font-mono text-xs text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none group-focus-within:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100",
						)}
					>
						{label}
					</button>
				</PopoverTrigger>
				<PopoverContent
					align="end"
					className="w-48 p-0"
					onOpenAutoFocus={(e) => e.preventDefault()}
				>
					<Command value={value}>
						<CommandInput placeholder={t("codeBlock.search")} />
						<CommandList className="max-h-[40vh]">
							<CommandEmpty>{t("codeBlock.noMatch")}</CommandEmpty>
							<CommandGroup>
								{LANGUAGES.map((lang) => (
									<LanguageItem
										key={lang}
										value={lang}
										label={lang}
										selected={value === lang}
										onSelect={onSelect}
									/>
								))}
							</CommandGroup>
						</CommandList>
					</Command>
				</PopoverContent>
			</Popover>
		</div>
	);
}

function LanguageItem({
	value,
	label,
	selected,
	onSelect,
}: {
	value: string;
	label: string;
	selected: boolean;
	onSelect: (value: string) => void;
}) {
	return (
		<CommandItem
			value={value}
			onSelect={() => onSelect(value)}
			data-checked={selected ? "true" : undefined}
		>
			<span className="font-mono">{label}</span>
		</CommandItem>
	);
}

function CopyCodeButton({ element }: { element: TCodeBlockElement }) {
	const { t } = useTranslation("editor");
	const [copied, setCopied] = React.useState(false);
	const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

	React.useEffect(
		() => () => {
			if (timerRef.current) clearTimeout(timerRef.current);
		},
		[],
	);

	const onCopy = async () => {
		// Per code_line: stringify each line, then join with "\n". Using
		// NodeApi.string on the whole code_block would flatten all descendant text
		// without inserting line breaks (Slate joins text nodes with ""), so lines
		// would collapse into one. Mirrors platejs's codeBlockToDecorations.
		const text = element.children
			.map((line) => NodeApi.string(line))
			.join("\n");
		const ok = await copyTextToClipboard(text, {
			errorMessage: t("codeBlock.copyFailed"),
		});
		if (!ok) return;
		setCopied(true);
		if (timerRef.current) clearTimeout(timerRef.current);
		timerRef.current = setTimeout(() => setCopied(false), 1500);
	};

	return (
		<div contentEditable={false}>
			<TooltipProvider delayDuration={300}>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							aria-label={t("codeBlock.copy")}
							onClick={onCopy}
							className={cn(
								"flex size-6 items-center justify-center rounded-md bg-background/80 text-muted-foreground opacity-0 backdrop-blur transition-opacity hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none group-focus-within:opacity-100 group-hover:opacity-100",
							)}
						>
							{copied ? (
								<CheckIcon className="size-3.5 text-green-600 dark:text-green-500" />
							) : (
								<CopyIcon className="size-3.5" />
							)}
						</button>
					</TooltipTrigger>
					<TooltipContent>{t("codeBlock.copy")}</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		</div>
	);
}

function MermaidPreview({ source }: { source: string }) {
	const { t } = useTranslation("editor");
	const previewId = React.useId().replace(/:/g, "");
	const [svg, setSvg] = React.useState<string | null>(null);
	const [renderError, setRenderError] = React.useState(false);
	const renderVersionRef = React.useRef(0);

	React.useEffect(() => {
		const sourceText = source.trim();
		const renderVersion = ++renderVersionRef.current;
		if (!sourceText) {
			setSvg(null);
			setRenderError(false);
			return;
		}

		let cancelled = false;
		const timeout = window.setTimeout(() => {
			void (async () => {
				try {
					// Mermaid drags in a multi-MB bundle, so it stays out of the editor
					// chunk — notes without diagrams never pay for it.
					const { mermaid } = await import("@streamdown/mermaid");
					const result = await mermaid
						.getMermaid()
						.render(
							`agentero-mermaid-${previewId}-${renderVersion}`,
							sourceText,
						);
					if (cancelled || renderVersionRef.current !== renderVersion) return;
					setSvg(result.svg);
					setRenderError(false);
				} catch {
					if (cancelled || renderVersionRef.current !== renderVersion) return;
					setSvg(null);
					setRenderError(true);
				}
			})();
		}, 160);

		return () => {
			cancelled = true;
			window.clearTimeout(timeout);
		};
	}, [previewId, source]);

	if (!svg && !renderError) return null;

	return (
		<div
			className="border-border/40 border-t bg-background/30 px-4 py-3 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full"
			contentEditable={false}
		>
			{svg ? (
				<MermaidSvg svg={svg} label={t("codeBlock.mermaidPreview")} />
			) : (
				<p className="m-0 text-muted-foreground text-xs">
					{t("codeBlock.mermaidPreviewError")}
				</p>
			)}
		</div>
	);
}

function MermaidSvg({ svg, label }: { svg: string; label: string }) {
	return (
		<div
			aria-label={label}
			dangerouslySetInnerHTML={{ __html: svg }}
			role="img"
		/>
	);
}

export function CodeBlockElement(props: PlateElementProps<TCodeBlockElement>) {
	const isMermaid = props.element.lang?.toLowerCase() === "mermaid";
	const source = isMermaid
		? props.element.children.map((line) => NodeApi.string(line)).join("\n")
		: "";

	return (
		// Constrain width so long lines overflow inside <pre> (scroll), not the editor.
		// Use agentero-scroll-both: agentero-scroll sets overflow-x:hidden (unlayered CSS
		// beats Tailwind overflow-x-auto). The x-only modifier lets vertical wheel
		// input continue to the document scroller. whitespace-pre overrides editor
		// break-spaces.
		<PlateElement className="max-w-full min-w-0 py-1" {...props}>
			<div className="agentero-codeblock group relative max-w-full min-w-0 overflow-hidden rounded-md bg-muted/50">
				<div
					contentEditable={false}
					className="absolute top-1.5 right-1.5 z-10 flex items-center gap-1"
				>
					<CodeLanguageSelect />
					<CopyCodeButton element={props.element} />
				</div>
				<pre className="agentero-scroll-both agentero-scroll-x-only max-w-full overflow-x-auto p-4 font-mono text-sm leading-[normal] whitespace-pre [tab-size:2]">
					<code className="block w-max min-w-full">{props.children}</code>
				</pre>
				{isMermaid ? <MermaidPreview source={source} /> : null}
			</div>
		</PlateElement>
	);
}

export function CodeLineElement(props: PlateElementProps) {
	return <PlateElement className="block whitespace-pre" {...props} />;
}

export function CodeSyntaxLeaf(props: PlateLeafProps<TCodeSyntaxLeaf>) {
	const tokenClassName = props.leaf.className as string;

	return <PlateLeaf className={tokenClassName} {...props} />;
}
