import { type ReactNode, useState } from "react";
import {
	Attachment,
	AttachmentGroup,
	AttachmentMedia,
	AttachmentTrigger,
} from "@/components/ui/attachment";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/core/utils";

export interface ChatImagePreview {
	id: string;
	src: string | null;
	openLabel: string;
	accessibleLabel: string;
	title: string;
	description: string;
	hideDescription?: boolean;
	previewAlt: string;
	fallback: ReactNode;
	details?: ReactNode;
}

/** Shared message-image interaction; callers provide annotation or attachment metadata. */
export function ChatImageGallery({
	items,
	className,
}: {
	items: ChatImagePreview[];
	className?: string;
}) {
	const [openId, setOpenId] = useState<string | null>(null);
	const open = items.find((item) => item.id === openId);
	if (!items.length) return null;
	return (
		<>
			<AttachmentGroup
				className={cn(
					"flex-wrap justify-end gap-1.5 overflow-visible py-0",
					className,
				)}
			>
				{items.map((item) => (
					<Attachment
						key={item.id}
						size="xs"
						className="size-9 min-w-0 rounded-md p-0!"
					>
						<AttachmentTrigger
							title={item.openLabel}
							aria-label={item.accessibleLabel}
							onClick={() => setOpenId(item.id)}
						/>
						<AttachmentMedia variant="image" className="size-full! rounded-md">
							{item.src ? (
								<img src={item.src} alt="" className="size-full object-cover" />
							) : (
								item.fallback
							)}
						</AttachmentMedia>
					</Attachment>
				))}
			</AttachmentGroup>
			<Dialog
				open={Boolean(open)}
				onOpenChange={(next) => {
					if (!next) setOpenId(null);
				}}
			>
				<DialogContent className="sm:max-w-md">
					{open ? (
						<>
							<DialogHeader>
								<DialogTitle>{open.title}</DialogTitle>
								<DialogDescription
									className={open.hideDescription ? "sr-only" : undefined}
								>
									{open.description}
								</DialogDescription>
							</DialogHeader>
							{open.src ? (
								<img
									src={open.src}
									alt={open.previewAlt}
									className="max-h-[min(60vh,28rem)] w-full rounded-lg border border-border/70 bg-muted/30 object-contain"
								/>
							) : null}
							{open.details}
						</>
					) : null}
				</DialogContent>
			</Dialog>
		</>
	);
}
