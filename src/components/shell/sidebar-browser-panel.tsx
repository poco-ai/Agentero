import type { IDockviewPanelProps } from "dockview-react";
import {
	ArrowLeft,
	ArrowRight,
	ExternalLink,
	Globe,
	RotateCw,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { useUiStore } from "@/hooks/use-app-stores";
import { useAnyModalOverlayOpen } from "@/hooks/use-overlay-registration";
import {
	commands,
	type SidebarBrowserCommand,
	type SidebarBrowserState,
} from "@/lib/core/bindings";
import { errorText } from "@/lib/core/error";
import { openExternalUrl } from "@/lib/core/open-external";
import {
	type SidebarPanelParams,
	updateSidebarBrowser,
} from "@/lib/shell/sidebar-tabs";
import {
	sidebarBrowserUrl,
	supportsSidebarBrowser,
} from "@/lib/web-view/sidebar-browser-url";
import { DOCKVIEW_DRAGGING_CLASS } from "@/lib/workspace/dockview-drag-selection";

async function browserCommand(viewId: string, command: SidebarBrowserCommand) {
	const result = await commands.sidebarBrowserCommand(viewId, command);
	if (result.status === "error") throw new Error(result.error);
	return result.data;
}

function samePage(
	previous: SidebarBrowserState | null,
	next: SidebarBrowserState,
) {
	return (
		previous?.url === next.url &&
		previous.title === next.title &&
		previous.loading === next.loading &&
		previous.canGoBack === next.canGoBack &&
		previous.canGoForward === next.canGoForward
	);
}

function boundsFor(element: HTMLElement) {
	const { left, top, right, bottom } = element.getBoundingClientRect();
	const x = Math.ceil(Math.max(0, left));
	const y = Math.ceil(Math.max(0, top));
	const width = Math.floor(Math.min(window.innerWidth, right)) - x;
	const height = Math.floor(Math.min(window.innerHeight, bottom)) - y;
	return width > 0 && height > 0 ? { x, y, width, height } : null;
}

export function SidebarBrowserPanel({
	api,
	params,
}: IDockviewPanelProps<SidebarPanelParams>) {
	const { t } = useTranslation("app");
	const savedUrl = params.target.kind === "browser" ? params.target.url : null;
	const [url, setUrl] = useState(savedUrl ?? "");
	const [draft, setDraft] = useState<string>();
	const [visible, setVisible] = useState(api.isVisible);
	const [page, setPage] = useState<SidebarBrowserState | null>(null);
	const [error, setError] = useState<string>();
	const [invalidAddress, setInvalidAddress] = useState(false);
	const railOpen = useUiStore((state) => state.rightSidebarOpen);
	const modalOpen = useAnyModalOverlayOpen();
	const content = useRef<HTMLDivElement>(null);
	const address = useRef<HTMLInputElement>(null);
	const lifecycle = useRef(Promise.resolve());
	const submit = useCallback(
		(command: SidebarBrowserCommand) => {
			const task = lifecycle.current.then(() =>
				browserCommand(api.id, command),
			);
			lifecycle.current = task.then(
				() => undefined,
				() => undefined,
			);
			return task;
		},
		[api.id],
	);
	const applyPage = useCallback((state: SidebarBrowserState | null) => {
		if (state) setPage((old) => (samePage(old, state) ? old : state));
	}, []);
	const supported = supportsSidebarBrowser();
	const active =
		supported && visible && railOpen && !modalOpen && Boolean(url) && !error;
	const urlRef = useRef(url);
	urlRef.current = url;

	useEffect(() => {
		const subscription = api.onDidVisibilityChange(({ isVisible }) =>
			setVisible(isVisible),
		);
		return () => subscription.dispose();
	}, [api]);
	useEffect(() => {
		if (savedUrl || !railOpen || !visible) return;
		const frame = requestAnimationFrame(() => {
			if (api.isActive) address.current?.focus({ preventScroll: true });
		});
		return () => cancelAnimationFrame(frame);
	}, [api, savedUrl, railOpen, visible]);
	useEffect(
		() => () => {
			if (supported) void submit({ kind: "close" }).catch(() => undefined);
		},
		[submit, supported],
	);

	useEffect(() => {
		if (!active || !content.current) return;
		const element = content.current;
		let stopped = false;
		let pending = false;
		let previousBounds = "";
		let frame = 0;
		const synchronize = () => {
			frame = 0;
			const bounds =
				document.visibilityState !== "hidden" &&
				!document.body.classList.contains(DOCKVIEW_DRAGGING_CLASS) &&
				!document.querySelector(
					'[data-slot="dropdown-menu-content"], [data-slot="context-menu-content"], [data-slot="dialog-content"], [role="alertdialog"]',
				)
					? boundsFor(element)
					: null;
			const key = bounds ? JSON.stringify(bounds) : "hidden";
			if (pending || previousBounds === key) return;
			previousBounds = key;
			pending = true;
			const command: SidebarBrowserCommand = bounds
				? { kind: "show", bounds, url: urlRef.current }
				: { kind: "hide" };
			void submit(command)
				.then(
					(state) => {
						if (!stopped) applyPage(state);
					},
					(failure: unknown) => {
						if (!stopped) setError(errorText(failure));
					},
				)
				.finally(() => {
					pending = false;
					if (!stopped) schedule();
				});
		};
		const schedule = () => {
			if (!frame) frame = requestAnimationFrame(synchronize);
		};
		const resize = new ResizeObserver(schedule);
		resize.observe(element);
		const mutations = new MutationObserver(schedule);
		mutations.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: ["class"],
		});
		window.addEventListener("resize", schedule);
		document.addEventListener("visibilitychange", schedule);
		schedule();
		const poll = setInterval(() => {
			if (pending || !previousBounds || previousBounds === "hidden") return;
			pending = true;
			void submit({ kind: "read" })
				.then((state) => {
					if (!stopped) applyPage(state);
				})
				.catch(() => undefined)
				.finally(() => {
					pending = false;
					if (!stopped) schedule();
				});
		}, 400);
		return () => {
			stopped = true;
			cancelAnimationFrame(frame);
			clearInterval(poll);
			resize.disconnect();
			mutations.disconnect();
			window.removeEventListener("resize", schedule);
			document.removeEventListener("visibilitychange", schedule);
			void submit({ kind: "hide" }).catch(() => undefined);
		};
	}, [active, applyPage, submit]);

	const current = page?.url || url;
	const title = page?.title || (current ? new URL(current).hostname : "");
	useEffect(() => {
		if (current && title) updateSidebarBrowser(api.id, current, title);
	}, [api.id, current, title]);

	const send = (command: SidebarBrowserCommand) => {
		void submit(command)
			.then(applyPage)
			.catch((failure: unknown) => setError(errorText(failure)));
	};

	return (
		<div
			data-sidebar-view={api.id}
			className="flex h-full min-h-0 min-w-0 flex-col bg-background"
		>
			<form
				className="flex min-w-0 shrink-0 items-center gap-0.5 border-b px-1.5 py-1"
				onSubmit={(event) => {
					event.preventDefault();
					const next = sidebarBrowserUrl(draft ?? current, true);
					if (!next) {
						setInvalidAddress(true);
						return;
					}
					if (!supported) {
						openExternalUrl(next);
						return;
					}
					setUrl(next);
					setDraft(undefined);
					setError(undefined);
					if (page) send({ kind: "navigate", url: next });
				}}
			>
				{supported && (
					<>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={t("sidebarBrowser.back")}
							disabled={!page?.canGoBack}
							onClick={() => send({ kind: "back" })}
						>
							<ArrowLeft aria-hidden />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={t("sidebarBrowser.forward")}
							disabled={!page?.canGoForward}
							onClick={() => send({ kind: "forward" })}
						>
							<ArrowRight aria-hidden />
						</Button>
						<Button
							type="button"
							variant="ghost"
							size="icon-xs"
							aria-label={t("sidebarBrowser.reload")}
							disabled={!url}
							onClick={() => {
								if (error) {
									setError(undefined);
								} else send({ kind: "reload" });
							}}
						>
							<RotateCw aria-hidden />
						</Button>
					</>
				)}
				<Input
					ref={address}
					value={draft ?? current}
					onChange={(event) => {
						setDraft(event.target.value);
						setInvalidAddress(false);
					}}
					onFocus={(event) => event.target.select()}
					onBlur={() => {
						setDraft(undefined);
						setInvalidAddress(false);
					}}
					onKeyDown={(event) => {
						if (event.key === "Escape") {
							setDraft(undefined);
							setInvalidAddress(false);
						}
					}}
					aria-label={t("sidebarBrowser.address")}
					placeholder={t("sidebarBrowser.address")}
					aria-invalid={invalidAddress}
					spellCheck={false}
					autoComplete="off"
					className="h-7 flex-1 text-xs"
				/>
				<Button
					type="button"
					variant="ghost"
					size="icon-xs"
					aria-label={t("sidebarBrowser.external")}
					disabled={!current}
					onClick={() => openExternalUrl(current)}
				>
					<ExternalLink aria-hidden />
				</Button>
			</form>
			<div
				ref={content}
				className="relative min-h-0 flex-1 overflow-hidden"
				aria-busy={page?.loading}
			>
				{(!supported || !url || error) && (
					<EmptyState className="h-full gap-2 px-4 text-center text-sm">
						<Globe className="size-5 text-muted-foreground" aria-hidden />
						<span>
							{error ||
								t(
									supported
										? "sidebarBrowser.address"
										: "sidebarBrowser.desktopOnly",
								)}
						</span>
					</EmptyState>
				)}
			</div>
		</div>
	);
}
