"use client";

// Application form and attachment lifecycle composed from upstream Input Group.
// Keep ACP and native capabilities outside UI primitives.

import type { ChatStatus, FileUIPart } from "ai";
import { ArrowUpIcon, SquareIcon, XIcon } from "lucide-react";
import { nanoid } from "nanoid";
import type {
	ChangeEventHandler,
	ClipboardEventHandler,
	ComponentProps,
	FormEvent,
	FormEventHandler,
	HTMLAttributes,
	KeyboardEventHandler,
	ReactNode,
	RefObject,
} from "react";
import {
	Children,
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { useImeGuard } from "@/hooks/use-ime-guard";
import {
	dataTransferLooksLikeOsFiles,
	fileMatchesAccept,
	filesFromDataTransfer,
} from "@/lib/core/file-accept";
import { cn } from "@/lib/core/utils";

// ============================================================================
// Helpers
// ============================================================================

const convertBlobUrlToDataUrl = async (url: string): Promise<string | null> => {
	try {
		const response = await fetch(url);
		const blob = await response.blob();
		// FileReader uses callback-based API, wrapping in Promise is necessary
		// oxlint-disable-next-line eslint-plugin-promise(avoid-new)
		return new Promise((resolve) => {
			const reader = new FileReader();
			// oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
			reader.onloadend = () => resolve(reader.result as string);
			// oxlint-disable-next-line eslint-plugin-unicorn(prefer-add-event-listener)
			reader.onerror = () => resolve(null);
			reader.readAsDataURL(blob);
		});
	} catch {
		return null;
	}
};

// ============================================================================
// Component Context & Hooks
// ============================================================================

export interface AttachmentsContext {
	files: (FileUIPart & { id: string })[];
	add: (files: File[] | FileList) => void;
	remove: (id: string) => void;
	clear: () => void;
	openFileDialog: () => void;
	fileInputRef: RefObject<HTMLInputElement | null>;
	/** When false, paste/drop/dialog no-ops (agent lacks image prompt capability). */
	enabled: boolean;
}

const LocalAttachmentsContext = createContext<AttachmentsContext | null>(null);

export const usePromptInputAttachments = () => {
	const context = useContext(LocalAttachmentsContext);
	if (!context) {
		throw new Error(
			"usePromptInputAttachments must be used within a PromptInput",
		);
	}
	return context;
};

// ============================================================================
// PromptInput
// ============================================================================

export interface PromptInputMessage {
	text: string;
	files: FileUIPart[];
}

export type PromptInputProps = Omit<
	HTMLAttributes<HTMLFormElement>,
	"onSubmit" | "onError"
> & {
	// e.g., "image/*" or leave undefined for any
	accept?: string;
	multiple?: boolean;
	// When true, accepts drops anywhere on document. Default false (opt-in).
	globalDrop?: boolean;
	// Render a hidden input with given name and keep it in sync for native form posts. Default false.
	syncHiddenInput?: boolean;
	// Minimal constraints
	maxFiles?: number;
	// bytes
	maxFileSize?: number;
	/**
	 * When false, file paste / drop / open dialog are disabled. Default true.
	 */
	attachmentsEnabled?: boolean;
	/** Class applied to the inner InputGroup. */
	inputGroupClassName?: string;
	onError?: (err: {
		code: "max_files" | "max_file_size" | "accept";
		message: string;
	}) => void;
	onSubmit: (
		message: PromptInputMessage,
		event: FormEvent<HTMLFormElement>,
	) => void | Promise<void>;
};

export const PromptInput = ({
	className,
	accept,
	multiple,
	globalDrop,
	syncHiddenInput,
	maxFiles,
	maxFileSize,
	attachmentsEnabled = true,
	inputGroupClassName,
	onError,
	onSubmit,
	children,
	...props
}: PromptInputProps) => {
	const { t } = useTranslation("aiElements");

	// Refs
	const inputRef = useRef<HTMLInputElement | null>(null);
	const formRef = useRef<HTMLFormElement | null>(null);

	// ----- Local attachments
	const [items, setItems] = useState<(FileUIPart & { id: string })[]>([]);

	// Keep a ref to files for cleanup on unmount (avoids stale closure)
	const filesRef = useRef(items);

	useEffect(() => {
		filesRef.current = items;
	}, [items]);

	const openFileDialog = useCallback(() => {
		if (!attachmentsEnabled) return;
		inputRef.current?.click();
	}, [attachmentsEnabled]);

	const matchesAccept = useCallback(
		(f: File) => fileMatchesAccept(f, accept),
		[accept],
	);

	const add = useCallback(
		(fileList: File[] | FileList) => {
			if (!attachmentsEnabled) return;
			const incoming = [...fileList];
			const accepted = incoming.filter((f) => matchesAccept(f));
			if (incoming.length && accepted.length === 0) {
				onError?.({
					code: "accept",
					message: t("promptInput.error.accept"),
				});
				return;
			}
			const withinSize = (f: File) =>
				maxFileSize ? f.size <= maxFileSize : true;
			const sized = accepted.filter(withinSize);
			if (accepted.length > 0 && sized.length === 0) {
				onError?.({
					code: "max_file_size",
					message: t("promptInput.error.maxFileSize"),
				});
				return;
			}

			setItems((prev) => {
				const capacity =
					typeof maxFiles === "number"
						? Math.max(0, maxFiles - prev.length)
						: undefined;
				const capped =
					typeof capacity === "number" ? sized.slice(0, capacity) : sized;
				if (typeof capacity === "number" && sized.length > capacity) {
					onError?.({
						code: "max_files",
						message: t("promptInput.error.maxFiles"),
					});
				}
				const next: (FileUIPart & { id: string })[] = [];
				for (const file of capped) {
					next.push({
						filename: file.name,
						id: nanoid(),
						mediaType: file.type,
						type: "file",
						url: URL.createObjectURL(file),
					});
				}
				return [...prev, ...next];
			});
		},
		[attachmentsEnabled, matchesAccept, maxFiles, maxFileSize, onError, t],
	);

	const remove = useCallback(
		(id: string) =>
			setItems((prev) => {
				const found = prev.find((file) => file.id === id);
				if (found?.url) {
					URL.revokeObjectURL(found.url);
				}
				return prev.filter((file) => file.id !== id);
			}),
		[],
	);

	const clearAttachments = useCallback(
		() =>
			setItems((prev) => {
				for (const file of prev) {
					if (file.url) {
						URL.revokeObjectURL(file.url);
					}
				}
				return [];
			}),
		[],
	);

	// Drop pending chips when capability turns off mid-session.
	useEffect(() => {
		if (!attachmentsEnabled && items.length > 0) {
			clearAttachments();
		}
	}, [attachmentsEnabled, items.length, clearAttachments]);

	// Note: File input cannot be programmatically set for security reasons
	// The syncHiddenInput prop is no longer functional
	useEffect(() => {
		if (syncHiddenInput && inputRef.current && items.length === 0) {
			inputRef.current.value = "";
		}
	}, [items, syncHiddenInput]);

	// Attach drop handlers on nearest form and document (opt-in)
	useEffect(() => {
		const form = formRef.current;
		if (!form || !attachmentsEnabled) {
			return;
		}
		if (globalDrop) {
			// when global drop is on, let the document-level handler own drops
			return;
		}

		const onDragOver = (e: DragEvent) => {
			if (dataTransferLooksLikeOsFiles(e.dataTransfer)) {
				e.preventDefault();
			}
		};
		const onDrop = (e: DragEvent) => {
			if (dataTransferLooksLikeOsFiles(e.dataTransfer)) {
				e.preventDefault();
			}
			const dropped = filesFromDataTransfer(e.dataTransfer);
			if (dropped.length > 0) {
				add(dropped);
			}
		};
		form.addEventListener("dragover", onDragOver);
		form.addEventListener("drop", onDrop);
		return () => {
			form.removeEventListener("dragover", onDragOver);
			form.removeEventListener("drop", onDrop);
		};
	}, [add, globalDrop, attachmentsEnabled]);

	useEffect(() => {
		if (!globalDrop || !attachmentsEnabled) {
			return;
		}

		const onDragOver = (e: DragEvent) => {
			if (dataTransferLooksLikeOsFiles(e.dataTransfer)) {
				e.preventDefault();
			}
		};
		const onDrop = (e: DragEvent) => {
			if (dataTransferLooksLikeOsFiles(e.dataTransfer)) {
				e.preventDefault();
			}
			const dropped = filesFromDataTransfer(e.dataTransfer);
			if (dropped.length > 0) {
				add(dropped);
			}
		};
		document.addEventListener("dragover", onDragOver);
		document.addEventListener("drop", onDrop);
		return () => {
			document.removeEventListener("dragover", onDragOver);
			document.removeEventListener("drop", onDrop);
		};
	}, [add, globalDrop, attachmentsEnabled]);

	useEffect(
		() => () => {
			for (const f of filesRef.current) {
				if (f.url) {
					URL.revokeObjectURL(f.url);
				}
			}
		},
		[],
	);

	const handleChange: ChangeEventHandler<HTMLInputElement> = useCallback(
		(event) => {
			if (event.currentTarget.files) {
				add(event.currentTarget.files);
			}
			// Reset input value to allow selecting files that were previously removed
			event.currentTarget.value = "";
		},
		[add],
	);

	const attachmentsCtx = useMemo<AttachmentsContext>(
		() => ({
			add,
			clear: clearAttachments,
			enabled: attachmentsEnabled,
			fileInputRef: inputRef,
			files: items.map((item) => ({ ...item, id: item.id })),
			openFileDialog,
			remove,
		}),
		[items, add, remove, clearAttachments, openFileDialog, attachmentsEnabled],
	);

	const handleSubmit: FormEventHandler<HTMLFormElement> = useCallback(
		async (event) => {
			event.preventDefault();

			const form = event.currentTarget;
			const formData = new FormData(form);
			const text = (formData.get("message") as string) || "";

			// Reset form immediately after capturing text to avoid race condition
			// where user input during async blob conversion would be lost
			form.reset();

			try {
				// Convert blob URLs to data URLs asynchronously
				const convertedFiles: FileUIPart[] = await Promise.all(
					items.map(async ({ id: _id, ...item }) => {
						if (item.url?.startsWith("blob:")) {
							const dataUrl = await convertBlobUrlToDataUrl(item.url);
							// If conversion failed, keep the original blob URL
							return {
								...item,
								url: dataUrl ?? item.url,
							};
						}
						return item;
					}),
				);

				const result = onSubmit({ files: convertedFiles, text }, event);

				// Handle both sync and async onSubmit
				if (result instanceof Promise) {
					try {
						await result;
						clearAttachments();
					} catch {
						// Don't clear on error - user may want to retry
					}
				} else {
					// Sync function completed without throwing, clear inputs
					clearAttachments();
				}
			} catch {
				// Don't clear on error - user may want to retry
			}
		},
		[items, onSubmit, clearAttachments],
	);

	// Provide LocalAttachmentsContext so children get validated add function
	return (
		<LocalAttachmentsContext.Provider value={attachmentsCtx}>
			<input
				accept={accept}
				aria-label={t("promptInput.uploadFiles")}
				className="hidden"
				multiple={multiple}
				onChange={handleChange}
				ref={inputRef}
				title={t("promptInput.uploadFiles")}
				type="file"
			/>
			<form
				className={cn("w-full", className)}
				onSubmit={handleSubmit}
				ref={formRef}
				{...props}
			>
				<InputGroup className={cn("overflow-hidden", inputGroupClassName)}>
					{children}
				</InputGroup>
			</form>
		</LocalAttachmentsContext.Provider>
	);
};

export type PromptInputBodyProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputBody = ({
	className,
	...props
}: PromptInputBodyProps) => (
	<div className={cn("contents", className)} {...props} />
);

export type PromptInputTextareaProps = ComponentProps<
	typeof InputGroupTextarea
>;

export const PromptInputTextarea = ({
	onChange,
	onKeyDown,
	className,
	placeholder,
	...props
}: PromptInputTextareaProps) => {
	const { t } = useTranslation("aiElements");
	const attachments = usePromptInputAttachments();
	// IME: compositionend can fire before the confirming Enter (see useImeGuard).
	const { isBlockedByIme, compositionProps } = useImeGuard();

	const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
		(e) => {
			// Block Enter submit before external handlers (e.g. mention menus)
			// so they do not select/submit while IME is confirming a candidate.
			if (e.key === "Enter" && isBlockedByIme(e)) {
				return;
			}

			// Call the external onKeyDown handler first
			onKeyDown?.(e);

			// If the external handler prevented default, don't run internal logic
			if (e.defaultPrevented) {
				return;
			}

			if (e.key === "Enter") {
				if (e.shiftKey) {
					return;
				}
				e.preventDefault();

				// Check if the submit button is disabled before submitting
				const { form } = e.currentTarget;
				const submitButton = form?.querySelector(
					'button[type="submit"]',
				) as HTMLButtonElement | null;
				if (submitButton?.disabled) {
					return;
				}

				form?.requestSubmit();
			}

			// Remove last attachment when Backspace is pressed and textarea is empty
			if (
				e.key === "Backspace" &&
				e.currentTarget.value === "" &&
				attachments.files.length > 0
			) {
				e.preventDefault();
				const lastAttachment = attachments.files.at(-1);
				if (lastAttachment) {
					attachments.remove(lastAttachment.id);
				}
			}
		},
		[onKeyDown, isBlockedByIme, attachments],
	);

	const handlePaste: ClipboardEventHandler<HTMLTextAreaElement> = useCallback(
		(event) => {
			if (!attachments.enabled) {
				return;
			}
			const items = event.clipboardData?.items;

			if (!items) {
				return;
			}

			const files: File[] = [];

			for (const item of items) {
				if (item.kind === "file") {
					const file = item.getAsFile();
					if (file) {
						files.push(file);
					}
				}
			}

			if (files.length > 0) {
				event.preventDefault();
				attachments.add(files);
			}
		},
		[attachments],
	);

	return (
		<InputGroupTextarea
			className={cn("field-sizing-content max-h-48 min-h-16", className)}
			name="message"
			{...compositionProps}
			onKeyDown={handleKeyDown}
			onPaste={handlePaste}
			placeholder={placeholder ?? t("promptInput.placeholder")}
			{...props}
			onChange={onChange}
		/>
	);
};

export type PromptInputFooterProps = Omit<
	ComponentProps<typeof InputGroupAddon>,
	"align"
>;

export const PromptInputFooter = ({
	className,
	...props
}: PromptInputFooterProps) => (
	<InputGroupAddon
		align="block-end"
		className={cn(
			// Wrap on narrow sidebars so tools never sit under the submit (↵) control.
			"flex flex-wrap items-center justify-between gap-1",
			className,
		)}
		{...props}
	/>
);

export type PromptInputToolsProps = HTMLAttributes<HTMLDivElement>;

export const PromptInputTools = ({
	className,
	...props
}: PromptInputToolsProps) => (
	<div
		className={cn(
			"flex min-w-0 flex-1 flex-wrap items-center gap-1",
			className,
		)}
		{...props}
	/>
);

export type PromptInputButtonTooltip =
	| string
	| {
			content: ReactNode;
			shortcut?: string;
			side?: ComponentProps<typeof TooltipContent>["side"];
	  };

export type PromptInputButtonProps = ComponentProps<typeof InputGroupButton> & {
	tooltip?: PromptInputButtonTooltip;
};

export const PromptInputButton = ({
	variant = "ghost",
	className,
	size,
	tooltip,
	...props
}: PromptInputButtonProps) => {
	const newSize =
		size ?? (Children.count(props.children) > 1 ? "sm" : "icon-sm");

	const button = (
		<InputGroupButton
			className={cn(className)}
			size={newSize}
			type="button"
			variant={variant}
			{...props}
		/>
	);

	if (!tooltip) {
		return button;
	}

	const tooltipContent =
		typeof tooltip === "string" ? tooltip : tooltip.content;
	const shortcut = typeof tooltip === "string" ? undefined : tooltip.shortcut;
	const side = typeof tooltip === "string" ? "top" : (tooltip.side ?? "top");

	return (
		<Tooltip>
			<TooltipTrigger asChild>{button}</TooltipTrigger>
			<TooltipContent side={side}>
				{tooltipContent}
				{shortcut && (
					<span className="ml-2 text-muted-foreground">{shortcut}</span>
				)}
			</TooltipContent>
		</Tooltip>
	);
};

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
	status?: ChatStatus;
	onStop?: () => void;
};

export const PromptInputSubmit = ({
	className,
	variant = "default",
	size = "icon-sm",
	status,
	onStop,
	onClick,
	children,
	...props
}: PromptInputSubmitProps) => {
	const { t } = useTranslation("aiElements");
	const isGenerating = status === "submitted" || status === "streaming";
	const canStop = isGenerating && Boolean(onStop);

	let Icon = <ArrowUpIcon className="size-3.5" />;

	if (status === "submitted") {
		Icon = <Spinner />;
	} else if (status === "streaming") {
		Icon = <SquareIcon className="size-3.5" />;
	} else if (status === "error") {
		Icon = <XIcon className="size-3.5" />;
	}

	const handleClick = useCallback(
		(e: React.MouseEvent<HTMLButtonElement>) => {
			if (canStop && onStop) {
				e.preventDefault();
				onStop();
				return;
			}
			onClick?.(e);
		},
		[canStop, onStop, onClick],
	);

	return (
		<InputGroupButton
			aria-label={canStop ? t("promptInput.stop") : t("promptInput.submit")}
			className={cn(className)}
			onClick={handleClick}
			size={size}
			type={canStop ? "button" : "submit"}
			variant={variant}
			{...props}
		>
			{children ?? Icon}
		</InputGroupButton>
	);
};
