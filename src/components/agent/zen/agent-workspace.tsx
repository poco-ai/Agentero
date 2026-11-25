/**
 * Agent workspace center: one Dockview tab per open conversation.
 *
 * Zen slots stay mounted behind their tabs (Dockview keeps inactive panels
 * alive), so background turns keep streaming. The left history rail creates
 * and focuses slots; this host mirrors them into Dockview panels.
 */

import "dockview";

import {
	type DockviewApi,
	type DockviewDefaultTab,
	DockviewReact,
	type DockviewReadyEvent,
	type IDockviewPanelProps,
} from "dockview-react";
import { Plus, Waves } from "lucide-react";
import {
	type ComponentProps,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { AgentSessionView } from "@/components/agent/zen/agent-session-panel";
import { useZenOpenRows } from "@/components/agent/zen/use-zen-open-rows";
import { DocumentTab } from "@/components/workspace/document-tab";
import { registerAgentDock } from "@/lib/agent/agent-dock-registry";
import { focusAgentComposer } from "@/lib/agent/composer-focus";
import { displayHistoryTitle } from "@/lib/agent/prompt-display";
import { useZenStore, zenStore } from "@/lib/agent/zen-store";
import { agenteroDockTheme } from "@/lib/workspace/dockview-theme";

const COMPONENT_SESSION = "agent-session";

/** Panel content: resolve its slot by id; Dockview keeps it mounted. */
function AgentSessionPanel(props: IDockviewPanelProps<{ slotId: string }>) {
	const slotId = props.params.slotId;
	const active = useZenStore((s) => s.activeSlotId === slotId);
	return <AgentSessionView slotId={slotId} autoFocus={active} />;
}

/** Tab chrome matches document tabs; the title follows session updates. */
function AgentSessionTab({
	api,
	containerApi: _containerApi,
	params: _params,
	onPointerDown,
	onPointerUp,
	onPointerLeave,
	tabLocation: _tabLocation,
	...rest
}: ComponentProps<typeof DockviewDefaultTab>) {
	const { t } = useTranslation("agent");
	const [title, setTitle] = useState(api.title);
	const middleClickRef = useRef(false);

	useEffect(() => {
		const disposable = api.onDidTitleChange((event) => setTitle(event.title));
		return () => disposable.dispose();
	}, [api]);

	return (
		<DocumentTab
			{...rest}
			data-panel-id={api.id}
			title={title}
			closeLabel={t("zen.close")}
			onClose={() => zenStore.getState().removeSlot(api.id)}
			onPointerDown={(event) => {
				middleClickRef.current = event.button === 1;
				onPointerDown?.(event);
			}}
			onPointerUp={(event) => {
				if (middleClickRef.current && event.button === 1) {
					zenStore.getState().removeSlot(api.id);
				}
				middleClickRef.current = false;
				onPointerUp?.(event);
			}}
			onPointerLeave={(event) => {
				middleClickRef.current = false;
				onPointerLeave?.(event);
			}}
		/>
	);
}

const components = { [COMPONENT_SESSION]: AgentSessionPanel };

function EmptyAgentWorkspace() {
	const { t } = useTranslation("agent");
	return (
		<div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-muted-foreground">
			<Waves className="size-6 opacity-60" aria-hidden />
			<button
				type="button"
				className="pointer-events-auto flex items-center justify-center gap-2 rounded-lg bg-foreground/5 px-4 py-2 text-foreground text-sm outline-none transition-[background-color,transform] duration-150 ease-out hover:bg-foreground/10 focus-visible:ring-1 focus-visible:ring-ring active:scale-[0.985] motion-reduce:transform-none"
				onClick={() => {
					zenStore.getState().addSlot();
					focusAgentComposer();
				}}
			>
				<Plus className="size-4 shrink-0" aria-hidden />
				{t("zen.newConversation")}
			</button>
		</div>
	);
}

export function AgentWorkspace() {
	const { t } = useTranslation("agent");
	const slots = useZenStore((s) => s.slots);
	const activeSlotId = useZenStore((s) => s.activeSlotId);
	const openRows = useZenOpenRows(slots);
	const apiRef = useRef<DockviewApi | null>(null);
	const removingRef = useRef(new Set<string>());

	const titles = useMemo(() => {
		const map = new Map<string, string>();
		for (const slot of slots) {
			const row =
				openRows.find((item) => item.slotId === slot.id && item.activeTab) ??
				openRows.find((item) => item.slotId === slot.id);
			const title =
				displayHistoryTitle(row?.title ?? "", "") || t("zen.untitled");
			map.set(slot.id, title);
		}
		return map;
	}, [slots, openRows, t]);

	// Mirror slot membership into Dockview panels.
	useEffect(() => {
		const api = apiRef.current;
		if (!api) return;
		const live = new Set(slots.map((slot) => slot.id));
		for (const slot of slots) {
			if (api.getPanel(slot.id)) continue;
			api.addPanel({
				id: slot.id,
				component: COMPONENT_SESSION,
				title: titles.get(slot.id) ?? t("zen.untitled"),
				renderer: "always",
				params: { slotId: slot.id },
			});
		}
		for (const panel of api.panels) {
			if (live.has(panel.id)) continue;
			removingRef.current.add(panel.id);
			api.removePanel(panel);
		}
	}, [slots, t, titles]);

	// Session title can change after the prompt starts streaming.
	useEffect(() => {
		const api = apiRef.current;
		if (!api) return;
		for (const slot of slots) {
			const panel = api.getPanel(slot.id);
			const title = titles.get(slot.id);
			if (panel && title && panel.api.title !== title) {
				panel.api.setTitle(title);
			}
		}
	}, [slots, titles]);

	// Sidebar activation and tab activation stay in sync.
	useEffect(() => {
		const api = apiRef.current;
		if (!api || !activeSlotId) return;
		if (api.activePanel?.id === activeSlotId) return;
		api.getPanel(activeSlotId)?.api.setActive();
	}, [activeSlotId]);

	const onReady = (event: DockviewReadyEvent) => {
		const api = event.api;
		apiRef.current = api;
		if (slots.length) {
			for (const slot of slots) {
				api.addPanel({
					id: slot.id,
					component: COMPONENT_SESSION,
					title: titles.get(slot.id) ?? t("zen.untitled"),
					renderer: "always",
					params: { slotId: slot.id },
				});
			}
			if (activeSlotId) api.getPanel(activeSlotId)?.api.setActive();
		}
		const disposables = [
			api.onDidActivePanelChange((change) => {
				const id = change.panel?.id;
				if (id) zenStore.getState().activateSlot(id);
			}),
			api.onDidRemovePanel((panel) => {
				if (removingRef.current.delete(panel.id)) return;
				zenStore.getState().removeSlot(panel.id);
			}),
		];
		registerAgentDock({
			closeActive: () => {
				const panel = api.activePanel;
				if (panel) zenStore.getState().removeSlot(panel.id);
			},
			cycleActive: (delta) => {
				const panel = api.activePanel;
				if (api.panels.length < 2 || !panel) return;
				const index = api.panels.indexOf(panel);
				const next =
					api.panels[(index + delta + api.panels.length) % api.panels.length];
				next?.api.setActive();
			},
			cycleGroupTab: (delta) => {
				const group = api.activeGroup;
				const panel = group?.activePanel;
				if (!group || group.panels.length < 2 || !panel) return;
				const index = group.panels.indexOf(panel);
				const next =
					group.panels[
						(index + delta + group.panels.length) % group.panels.length
					];
				next?.api.setActive();
			},
		});
		disposablesRef.current = disposables;
	};

	const disposablesRef = useRef<{ dispose: () => void }[]>([]);

	useEffect(
		() => () => {
			for (const disposable of disposablesRef.current) disposable.dispose();
			disposablesRef.current = [];
			apiRef.current = null;
			registerAgentDock(null);
		},
		[],
	);

	return (
		<div className="relative h-full min-h-0 w-full">
			<div
				className="agentero-dockview agentero-dock-global h-full min-h-0 w-full"
				data-agent-workspace
			>
				<DockviewReact
					className="h-full w-full"
					theme={agenteroDockTheme}
					components={components}
					defaultTabComponent={AgentSessionTab}
					disableFloatingGroups
					dndStrategy="pointer"
					dndEdges={{ size: { value: 24, type: "pixels" } }}
					keyboardNavigation
					onReady={onReady}
				/>
			</div>
			{slots.length === 0 ? <EmptyAgentWorkspace /> : null}
		</div>
	);
}
