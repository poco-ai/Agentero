import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { EmptyState } from "@/components/ui/empty-state";
import { useIframeDragShield } from "@/hooks/use-iframe-drag-shield";
import { commands } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";
import { notifyError } from "@/lib/core/notify";
import { cn } from "@/lib/core/utils";
import {
	LOCAL_HTML_SANDBOX,
	localHtmlPreviewUrl,
} from "@/lib/web-view/html-preview-url";

type LocalHtmlViewerProps = {
	/** Absolute vault path of the `.html` file. */
	path: string;
	/** Bumped when the file changes on disk so the frame refetches. */
	reloadKey: number;
	title?: string;
	className?: string;
};

type Grant = { path: string; token: string; name: string };

/**
 * Sandboxed preview of a vault HTML file.
 *
 * The frame loads `agentero-html://`, not `srcdoc`, and its sandbox is only
 * `allow-scripts`. Remote paper pages stay on `HtmlViewer`.
 */
export function LocalHtmlViewer({
	path,
	reloadKey,
	title,
	className,
}: LocalHtmlViewerProps) {
	const { t } = useTranslation("viewer");
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const grantRef = useRef<Grant | null>(null);
	const [src, setSrc] = useState<string | null>(null);
	const [failed, setFailed] = useState(false);
	const dragShield = useIframeDragShield();

	useEffect(() => {
		let cancelled = false;
		const cached = grantRef.current;
		const sameFile = cached?.path === path ? cached : null;
		if (!sameFile) setSrc(null);
		setFailed(false);
		void (async () => {
			try {
				const grant =
					sameFile ??
					(await callApiResult(() => commands.htmlPreviewGrant({ path })));
				if (cancelled) return;
				grantRef.current = { path, token: grant.token, name: grant.name };
				setSrc(localHtmlPreviewUrl(grant.token, grant.name, reloadKey));
			} catch {
				if (cancelled) return;
				grantRef.current = null;
				setSrc(null);
				setFailed(true);
				notifyError(t("html.localFailed"));
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [path, reloadKey, t]);

	if (failed || !src) {
		return (
			<EmptyState className={className}>
				{failed ? t("html.localFailed") : null}
			</EmptyState>
		);
	}

	return (
		<div
			className={cn(
				"relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-background",
				className,
			)}
		>
			<iframe
				title={title || t("html.localTitle")}
				src={src}
				sandbox={LOCAL_HTML_SANDBOX}
				referrerPolicy="no-referrer"
				ref={iframeRef}
				className={cn(
					"absolute inset-0 block h-full w-full border-0 bg-background",
					dragShield && "pointer-events-none",
				)}
			/>
		</div>
	);
}
