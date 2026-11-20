import {
	getCurrentWebviewWindow,
	WebviewWindow,
} from "@tauri-apps/api/webviewWindow";
import { type RefObject, useEffect } from "react";
import {
	commands,
	events,
	type Json,
	type WorkspaceRequest,
} from "@/lib/core/bindings";
import { normalizePath } from "@/lib/core/path";
import { isTauri } from "@/lib/core/tauri";
import { listenEventSafe } from "@/lib/core/tauri-events";
import { openLocalVaultPath } from "@/lib/vault/actions";
import { joinVaultPath, vaultRelativePath } from "@/lib/vault/path";
import { getVaultPath } from "@/lib/vault/store";
import { dockHandle } from "@/lib/workspace/dock-registry";
import { getActiveTabId, getTabs } from "@/lib/workspace/store";
import {
	type DocTab,
	findCanonicalTab,
	type SplitDirection,
} from "@/lib/workspace/tabs";

function object(value: Json): Record<string, Json> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: {};
}

async function waitFor<T>(
	read: () => T | undefined,
	message: string,
): Promise<T> {
	const deadline = Date.now() + 4000;
	do {
		const result = read();
		if (result !== undefined) return result;
		await new Promise((resolve) => setTimeout(resolve, 40));
	} while (Date.now() < deadline);
	throw new Error(message);
}

async function dispatch(
	req: WorkspaceRequest,
	doc?: RefObject<DocTab | null>,
): Promise<Json> {
	const args = object(req.args);
	const win = getCurrentWebviewWindow();
	let vault = getVaultPath();
	const ownsVault = () =>
		!req.vault || normalizePath(req.vault) === normalizePath(vault ?? "");
	const describe = (tab: DocTab) => ({
		view: tab.id,
		window: win.label,
		path: vault ? (vaultRelativePath(vault, tab.path) ?? tab.path) : tab.path,
		active: !!doc || tab.id === getActiveTabId(),
	});
	if (req.route === "app views") {
		const tabs = doc ? (doc.current ? [doc.current] : []) : getTabs();
		return { items: ownsVault() ? tabs.map(describe) : [] };
	}
	if (!ownsVault()) {
		if (req.route !== "app open" || doc || !req.vault)
			throw new Error("Window belongs to another vault");
		await openLocalVaultPath(req.vault);
		vault = getVaultPath();
		if (!ownsVault()) throw new Error("Could not open requested vault");
	}
	const {
		closeTab,
		openTab,
		openVaultRel,
		splitActivePane,
		openEvidenceLocation,
	} = await import("@/lib/workspace/actions");
	if (req.route === "app close") {
		const id = args.view;
		if (typeof id !== "string") throw new Error("Missing view ID");
		if (doc) {
			if (doc.current?.id !== id) throw new Error("View not found");
			// Host waits for the actual window to disappear, including any save veto.
			await win.close();
		} else {
			if (!getTabs().some((t) => t.id === id))
				throw new Error("View not found");
			closeTab(id);
			await waitFor(
				() => (getTabs().some((t) => t.id === id) ? undefined : true),
				"View could not be closed",
			);
		}
		return {
			changed: true,
			items: [{ id, outcome: "closed" }],
			preview: false,
		};
	}
	if (doc) throw new Error("This command requires the main workspace");
	if (req.route === "app window") {
		const feature = args.feature;
		if (feature === "settings") {
			const res = await commands.settingsWindowOpen(
				typeof args.section === "string" ? args.section : null,
				vault,
			);
			if (res.status === "error") throw new Error(res.error);
			return { window: "settings" };
		}
		if (feature !== "agent" && feature !== "annotations")
			throw new Error("Unknown feature window");
		if (args.section) throw new Error("--section is only valid for settings");
		const { openFeatureWindow, featureWindowLabel } = await import(
			"@/lib/shell/feature-window"
		);
		await openFeatureWindow(feature);
		const label = featureWindowLabel(feature);
		if (!(await WebviewWindow.getByLabel(label)))
			throw new Error("Feature window failed to open");
		return { window: label };
	}
	if (!vault) throw new Error("Open a vault first");
	const target = typeof args.target === "string" ? args.target : "";
	const abs = target ? joinVaultPath(vault, target) : "";
	const loc = args.locator;
	const findOpened = () => {
		const tabs = getTabs();
		if (!target) return tabs.find((t) => t.id === getActiveTabId());
		return (
			findCanonicalTab(tabs, abs) ??
			tabs.find(
				(t) =>
					t.kind === "paper" &&
					normalizePath(abs).startsWith(normalizePath(t.path) + "/"),
			)
		);
	};
	if (req.route === "app split") {
		const beside =
			typeof args.beside === "string" ? args.beside : getActiveTabId();
		if (!beside || !dockHandle()?.canActivatePanel(beside))
			throw new Error("Reference view not found");
		dockHandle()?.activatePanel(beside);
		const direction = (args.direction ?? "right") as SplitDirection;
		if (!["left", "right", "above", "below", "within"].includes(direction))
			throw new Error("Invalid split direction");
		if (target && !findOpened()) {
			openTab(abs, { placement: { referencePanelId: beside, direction } });
		} else {
			const source = target
				? findOpened()
				: getTabs().find((t) => t.id === beside);
			if (!source) throw new Error("Source view not found");
			const before = new Set(getTabs().map((t) => t.id));
			splitActivePane({ source: source.id, beside, direction });
			const split = await waitFor(
				() => getTabs().find((t) => !before.has(t.id)),
				"View does not support splitting",
			);
			return describe(split);
		}
	} else if (req.route === "app open") {
		if (target && !loc) openVaultRel(target);
	} else throw new Error("Unknown workspace operation");
	if (target && loc) await openEvidenceLocation(target, loc);
	const opened = await waitFor(findOpened, "Document view did not open");
	if (req.route === "app open" && getActiveTabId() !== opened.id) {
		const dock = await waitFor(() => {
			const handle = dockHandle();
			return handle?.canActivatePanel(opened.id) ? handle : undefined;
		}, "Document panel is unavailable");
		dock.activatePanel(opened.id);
		await waitFor(
			() => (getActiveTabId() === opened.id ? true : undefined),
			"Document could not be focused",
		);
	}
	return describe(opened);
}

export function useWorkspaceCli(doc?: RefObject<DocTab | null>) {
	useEffect(() => {
		// Startup delivery may retry until the window has mounted. A view mutation
		// must execute only once even when it outlives the next delivery attempt.
		if (!isTauri()) return;
		const handled = new Map<string, Promise<Json>>();
		return listenEventSafe(
			events.cliWorkspace(getCurrentWebviewWindow()),
			(req) => {
				let job = handled.get(req.id);
				if (!job) {
					job = dispatch(req, doc);
					handled.set(req.id, job);
					const release = () => setTimeout(() => handled.delete(req.id), 15000);
					void job.then(release, release);
				}
				void job
					.then(
						(value) =>
							commands.workspaceCliReply({ id: req.id, value, error: null }),
						(err) =>
							commands.workspaceCliReply({
								id: req.id,
								value: null,
								error: String(err),
							}),
					)
					.catch(() => {});
			},
		);
	}, [doc]);
}
