import { Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { SelectionCopiedLabel } from "@/components/ui/selection-copied-label";
import { AskPopover } from "@/components/viewer/pdf/cards/ask-popover";
import { SelectionMenu } from "@/components/viewer/pdf/cards/selection-menu";
import { TranslateCard } from "@/components/viewer/pdf/cards/translate-card";
import { useWebViewSelection } from "@/components/viewer/web-view/use-web-view-selection";
import { useIframeDragShield } from "@/hooks/use-iframe-drag-shield";
import { commands } from "@/lib/core/bindings";
import { callApiResult } from "@/lib/core/ipc";
import { openExternalUrl } from "@/lib/core/open-external";
import { cn } from "@/lib/core/utils";
import { isArxivHostedUrl } from "@/lib/paper/arxiv";
import {
	loadArxivHtml,
	peekArxivHtml,
	resolveArxivHtmlPage,
} from "@/lib/paper/arxiv-html";
import { webViewProxyUrl } from "@/lib/web-view/proxy-url";

type HtmlViewerProps = {
	/** Remote URL only — streamed in a sandboxed iframe (no local download) */
	srcUrl?: string | null;
	/** Paper title for ask-card / prompt context. */
	title?: string;
	className?: string;
	/** Return a PDF paper to its PDF view when HTML cannot be shown. */
	onShowPdf?: () => void;
};

/** arXiv HTML is a srcdoc of third-party markup. It must not share the app origin. */
const ARXIV_HTML_SANDBOX =
	"allow-scripts allow-popups allow-popups-to-escape-sandbox";

type ArxivHtmlPhase = "loading" | "ready" | "missing" | "network" | "bad_url";

/** Load-state of the built-in proxy for one paper host. */
type ProxyGate = "pending" | "ready" | "denied";

/**
 * HTML paper viewer — remote page in a sandboxed iframe.
 * Does not fetch or cache HTML into the vault.
 *
 * arXiv papers are fetched in this webview and embedded as srcdoc. Every other
 * host is served through the generic `agentero-web` proxy (host allowlisted
 * via the Host command first), which injects the selection bridge the toolbar
 * below needs.
 */
export function HtmlViewer({
	srcUrl,
	title,
	className,
	onShowPdf,
}: HtmlViewerProps) {
	const { t } = useTranslation("viewer");
	const iframeRef = useRef<HTMLIFrameElement | null>(null);
	const dragShield = useIframeDragShield();
	const [gate, setGate] = useState<ProxyGate>("pending");

	const remote = srcUrl && /^https?:\/\//i.test(srcUrl) ? srcUrl : null;
	const trusted = remote ? isArxivHostedUrl(remote) : false;
	const arxivTarget = remote && trusted ? resolveArxivHtmlPage(remote) : null;
	const arxivPageUrl = arxivTarget?.pageUrl ?? null;
	const [arxiv, setArxiv] = useState<{
		url: string;
		phase: ArxivHtmlPhase;
		html: string | null;
	} | null>(null);

	useEffect(() => {
		if (!arxivPageUrl) return;
		const cached = peekArxivHtml(arxivPageUrl);
		if (cached) {
			setArxiv({ url: arxivPageUrl, phase: "ready", html: cached });
		} else {
			setArxiv({ url: arxivPageUrl, phase: "loading", html: null });
		}
		const controller = new AbortController();
		void loadArxivHtml(arxivPageUrl, controller.signal).then((result) => {
			if (controller.signal.aborted || result.status === "aborted") return;
			setArxiv({
				url: arxivPageUrl,
				phase: result.status === "ready" ? "ready" : result.status,
				html: result.status === "ready" ? result.html : null,
			});
		});
		return () => controller.abort();
	}, [arxivPageUrl]);

	// Ensure the host may be served before the frame points at the proxy —
	// the proxy answers 403 otherwise.
	useEffect(() => {
		if (!remote || trusted) return;
		let cancelled = false;
		setGate("pending");
		void (async () => {
			let host = "";
			try {
				host = new URL(remote).hostname;
			} catch {
				if (!cancelled) setGate("denied");
				return;
			}
			try {
				const accepted = await callApiResult(() =>
					commands.webProxyAllowHost({ host }),
				);
				if (!cancelled) setGate(accepted ? "ready" : "denied");
			} catch {
				if (!cancelled) setGate("denied");
			}
		})();
		return () => {
			cancelled = true;
		};
	}, [remote, trusted]);

	const selection = useWebViewSelection({
		srcUrl: remote ?? "",
		iframeRef,
		title,
	});

	if (!remote) {
		return (
			<div
				className={cn(
					"flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm",
					className,
				)}
			>
				{t("html.empty")}
			</div>
		);
	}

	if (trusted) {
		const cachedHtml = arxivPageUrl ? peekArxivHtml(arxivPageUrl) : null;
		const current = arxiv?.url === arxivPageUrl ? arxiv : null;
		const arxivHtml = cachedHtml ?? current?.html ?? null;
		const phase: ArxivHtmlPhase = !arxivTarget
			? "bad_url"
			: arxivHtml
				? "ready"
				: (current?.phase ?? "loading");
		return (
			<div
				className={cn(
					"relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-background",
					className,
				)}
				data-arxiv-html={phase}
				aria-busy={phase === "loading" || undefined}
			>
				{phase === "ready" && arxivHtml ? (
					<iframe
						title={t("html.sandboxTitle")}
						srcDoc={arxivHtml}
						sandbox={ARXIV_HTML_SANDBOX}
						referrerPolicy="no-referrer"
						ref={iframeRef}
						onLoad={selection.onFrameLoad}
						className={cn(
							"absolute inset-0 block h-full w-full border-0 bg-background",
							dragShield && "pointer-events-none",
						)}
						style={{ colorScheme: "light dark" }}
					/>
				) : (
					<ArxivHtmlStatus
						phase={phase}
						absUrl={arxivTarget?.absUrl ?? null}
						onShowPdf={onShowPdf}
					/>
				)}
			</div>
		);
	}

	const iframeUrl = gate === "ready" ? webViewProxyUrl(remote) : null;
	const sandbox =
		"allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox";

	return (
		<div
			className={cn(
				"relative h-full min-h-0 w-full min-w-0 overflow-hidden bg-background",
				className,
			)}
		>
			{iframeUrl ? (
				<iframe
					title={t("html.sandboxTitle")}
					src={iframeUrl}
					sandbox={sandbox}
					referrerPolicy="no-referrer-when-downgrade"
					ref={iframeRef}
					onLoad={selection.onFrameLoad}
					className={cn(
						"absolute inset-0 block h-full w-full border-0 bg-background",
						dragShield && "pointer-events-none",
					)}
					style={{ colorScheme: "light dark" }}
				/>
			) : (
				<div className="flex h-full items-center justify-center p-6 text-center text-muted-foreground text-sm">
					{gate === "denied" ? t("html.denied") : null}
				</div>
			)}
			{iframeUrl && !trusted
				? createPortal(
						<>
							{selection.menu && !selection.ask ? (
								<SelectionMenu
									screen={selection.menu.screen}
									onHighlight={() => undefined}
									onAsk={selection.handleAsk}
									onAddToChat={selection.handleAddToChat}
									onTranslate={selection.handleTranslate}
									showHighlight={false}
								/>
							) : null}
							{selection.copiedLabelPos ? (
								<SelectionCopiedLabel
									x={selection.copiedLabelPos.x}
									y={selection.copiedLabelPos.y}
								/>
							) : null}
							{selection.ask ? (
								<AskPopover
									thread={selection.ask.thread}
									paperTitle={title}
									paperLink={remote}
									screen={selection.ask.screen}
									streaming={selection.streaming}
									error={selection.askError}
									onSend={selection.sendAskQuestion}
									onResend={selection.resendAskQuestion}
									onHide={selection.hideAsk}
									onDelete={selection.deleteAsk}
									onStop={selection.stopAskStreaming}
								/>
							) : null}
							{selection.translateRec && selection.translateScreen ? (
								<TranslateCard
									screen={selection.translateScreen}
									result={selection.translateRec.result ?? ""}
									streaming={selection.translateStreaming}
									error={
										selection.translateError ??
										selection.translateRec.error ??
										null
									}
									onOpenSettings={selection.openTranslateSettings}
									onHide={selection.hideTranslate}
								/>
							) : null}
						</>,
						document.body,
					)
				: null}
		</div>
	);
}

function ArxivHtmlStatus({
	phase,
	absUrl,
	onShowPdf,
}: {
	phase: ArxivHtmlPhase;
	absUrl: string | null;
	onShowPdf?: () => void;
}) {
	const { t } = useTranslation("viewer");
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-muted-foreground text-sm">
			{phase === "loading" ? (
				<Loader2 className="size-4 animate-spin" aria-hidden />
			) : null}
			<p>
				{phase === "loading"
					? t("html.loading")
					: phase === "missing"
						? t("html.missing")
						: phase === "network"
							? t("html.network")
							: t("html.badUrl")}
			</p>
			{phase === "loading" ? null : (
				<div className="flex flex-wrap items-center justify-center gap-2">
					{onShowPdf ? (
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={onShowPdf}
						>
							{t("html.backToPdf")}
						</Button>
					) : null}
					{absUrl ? (
						<Button
							type="button"
							size="sm"
							variant="outline"
							onClick={() => openExternalUrl(absUrl)}
						>
							{t("html.openAbstract")}
						</Button>
					) : null}
				</div>
			)}
		</div>
	);
}
