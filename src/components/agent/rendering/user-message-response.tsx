import { ChevronDown, FileText } from "lucide-react";
import { useMemo } from "react";
import {
	Attachment,
	AttachmentContent,
	AttachmentMedia,
	AttachmentTitle,
	AttachmentTrigger,
} from "@/components/ui/attachment";
import {
	Collapsible,
	CollapsibleContent,
	CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { splitPiAttachmentReferences } from "@/lib/agent/pi-attachment-display";
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
					<Collapsible
						key={part.start}
						className="group/pi-attachment min-w-0 max-w-full"
					>
						<Attachment size="xs" className="min-w-0 max-w-full">
							<AttachmentMedia>
								<FileText aria-hidden />
							</AttachmentMedia>
							<AttachmentContent>
								<AttachmentTitle>{name}</AttachmentTitle>
							</AttachmentContent>
							<ChevronDown
								aria-hidden
								className="mr-1 size-3.5 shrink-0 group-data-[state=open]/pi-attachment:rotate-180"
							/>
							<CollapsibleTrigger asChild>
								<AttachmentTrigger aria-label={name} title={part.path} />
							</CollapsibleTrigger>
						</Attachment>
						<CollapsibleContent className="select-text whitespace-pre-wrap break-all pt-2 text-xs text-muted-foreground">
							{part.path}
						</CollapsibleContent>
					</Collapsible>
				);
			})}
		</div>
	);
}
