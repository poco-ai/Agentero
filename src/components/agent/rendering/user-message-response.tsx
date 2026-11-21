import { FileText } from "lucide-react";
import { useMemo } from "react";
import { SENT_MESSAGE_CHIP_CLASS } from "@/components/agent/reference-chip-style";
import {
	Tooltip,
	TooltipContent,
	TooltipProvider,
	TooltipTrigger,
} from "@/components/ui/tooltip";
import { splitPiAttachmentReferences } from "@/lib/agent/pi-attachment-display";
import { cn } from "@/lib/core/utils";
import { MessageResponse, type MessageResponseProps } from "./message-response";

/** Compact transport references only in user bubbles, never assistant/code output. */
export function UserMessageResponse({
	children = "",
	...props
}: Omit<MessageResponseProps, "children"> & { children?: string }) {
	const parts = useMemo(
		() => splitPiAttachmentReferences(children),
		[children],
	);
	if (!parts.some((part) => part.path)) {
		return <MessageResponse {...props}>{children}</MessageResponse>;
	}
	return (
		<TooltipProvider delayDuration={300}>
			<div className="min-w-0 max-w-full space-y-2">
				{parts.map((part) => {
					if (!part.path)
						return (
							<MessageResponse key={part.start} {...props}>
								{part.text}
							</MessageResponse>
						);
					const name = part.path.split(/[\\/]/).at(-1) ?? part.path;
					return (
						<div key={part.start}>
							<Tooltip>
								<TooltipTrigger asChild tabIndex={0}>
									<span
										className={cn(
											SENT_MESSAGE_CHIP_CLASS,
											"max-w-[min(12rem,calc(100%-0.25rem))] focus-visible:outline-ring",
										)}
									>
										<FileText
											aria-hidden
											className="size-3 shrink-0 text-muted-foreground"
										/>
										<span className="min-w-0 truncate">{name}</span>
									</span>
								</TooltipTrigger>
								<TooltipContent sideOffset={4}>
									<span className="min-w-0 break-all">{part.path}</span>
								</TooltipContent>
							</Tooltip>
						</div>
					);
				})}
			</div>
		</TooltipProvider>
	);
}
