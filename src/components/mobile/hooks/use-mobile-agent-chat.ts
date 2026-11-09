import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	appendAssistantLine,
	appendStreamChunk,
	appendUserLine,
	completeStream,
} from "@/components/mobile/chat-lines";
import type {
	AcpLoadSessionResult,
	AgentFailedEvent,
	AgentLine,
	AgentPermissionRequest,
	AgentResultEvent,
	AgentStatusEvent,
	AgentStreamEvent,
	AgentTurnPhase,
} from "@/components/mobile/types";
import { bridgeRpc, listenBridgeEvent } from "@/lib/bridge/client";
import { toSafeDisposer } from "@/lib/core/tauri-events";

/**
 * Chat state machine for the mobile agent page: subscribes to the bridged
 * agent events of the current session, restores the timeline on launch and
 * when returning to the foreground, and submits new prompts.
 */
export function useMobileAgentChat({
	agentId,
	sessionId,
	onSessionId,
}: {
	agentId: string | null;
	sessionId: string | null;
	onSessionId: (sessionId: string | null) => void;
}) {
	const { t } = useTranslation("mobile");
	const [lines, setLines] = useState<AgentLine[]>([]);
	const [sending, setSending] = useState(false);
	const [restoring, setRestoring] = useState(false);
	const [permission, setPermission] = useState<AgentPermissionRequest | null>(
		null,
	);
	/** Loading phase of the in-flight turn (label under the sending state). */
	const [phase, setPhase] = useState<AgentStatusEvent | null>(null);
	const sessionRef = useRef<string | null>(sessionId);
	const pendingPermissionRef = useRef<AgentPermissionRequest | null>(null);
	pendingPermissionRef.current = permission;

	const restore = useCallback(
		async (target: string) => {
			setRestoring(true);
			try {
				const history = await bridgeRpc<AcpLoadSessionResult>(
					"agent_load_session",
					{
						agentId: agentId ?? undefined,
						sessionId: target,
					},
				);
				sessionRef.current = history.sessionId;
				onSessionId(history.sessionId);
				setLines(
					history.lines.map((line) => ({
						id: line.id,
						role: line.kind === "user" ? "user" : "assistant",
						text: line.text,
					})),
				);
			} catch {
				// Session history is best-effort; keep the current timeline.
			} finally {
				setRestoring(false);
			}
		},
		[agentId, onSessionId],
	);

	useEffect(() => {
		if (sessionRef.current) void restore(sessionRef.current);
	}, [restore]);

	useEffect(() => {
		const onVisible = () => {
			if (document.visibilityState !== "visible") return;
			if (sessionRef.current) void restore(sessionRef.current);
		};
		document.addEventListener("visibilitychange", onVisible);
		return () => document.removeEventListener("visibilitychange", onVisible);
	}, [restore]);

	useEffect(() => {
		let active = true;
		const unlisten = [
			toSafeDisposer(
				listenBridgeEvent<AgentStreamEvent>("agent:stream", (event) => {
					if (!active || event.sessionId !== sessionRef.current) return;
					setPhase(null);
					setLines((current) => appendStreamChunk(current, event.chunk));
				}),
			),
			toSafeDisposer(
				listenBridgeEvent<AgentStatusEvent>("agent:status", (event) => {
					if (!active || event.sessionId !== sessionRef.current) return;
					if (
						event.phase !== "starting" &&
						event.phase !== "waiting-model" &&
						event.phase !== "reconnecting"
					) {
						return;
					}
					setPhase({ ...event, phase: event.phase as AgentTurnPhase });
				}),
			),
			toSafeDisposer(
				listenBridgeEvent<AgentResultEvent>("agent:completed", (event) => {
					if (!active || event.sessionId !== sessionRef.current) return;
					setSending(false);
					setPhase(null);
					setLines((current) => completeStream(current, event.content));
				}),
			),
			toSafeDisposer(
				listenBridgeEvent<AgentFailedEvent>("agent:failed", (event) => {
					if (!active || event.sessionId !== sessionRef.current) return;
					setSending(false);
					setPhase(null);
					setLines((current) =>
						appendAssistantLine(current, event.error || t("agent.failed")),
					);
				}),
			),
			toSafeDisposer(
				listenBridgeEvent<AgentPermissionRequest>(
					"agent:permission-request",
					(event) => {
						if (!active || event.sessionId !== sessionRef.current) return;
						setPermission(event);
					},
				),
			),
		];
		return () => {
			active = false;
			for (const off of unlisten) off();
			const pending = pendingPermissionRef.current;
			if (pending) {
				void bridgeRpc("agent_respond_permission", {
					requestId: pending.requestId,
					optionId: null,
				});
			}
		};
	}, [t]);

	const clearSession = useCallback(() => {
		const current = sessionRef.current;
		sessionRef.current = null;
		setLines([]);
		setSending(false);
		setPhase(null);
		setPermission(null);
		onSessionId(null);
		if (current) {
			void bridgeRpc("agent_cancel_run", { sessionId: current }).catch(
				() => undefined,
			);
		}
	}, [onSessionId]);

	const respondToPermission = useCallback((optionId: string | null) => {
		const pending = pendingPermissionRef.current;
		if (!pending) return;
		setPermission(null);
		void bridgeRpc("agent_respond_permission", {
			requestId: pending.requestId,
			optionId,
		});
	}, []);

	const send = useCallback(
		async (value: string) => {
			const next = value.trim();
			if (!next || sending) return;
			setLines((previous) => appendUserLine(previous, next));
			setSending(true);
			setPhase(null);
			try {
				const accepted = await bridgeRpc<{ sessionId: string }>(
					"agent_run_once",
					{
						agentId: agentId ?? undefined,
						prompt: next,
						permissionMode: "ask",
					},
				);
				sessionRef.current = accepted.sessionId;
				onSessionId(accepted.sessionId);
			} catch (error) {
				setSending(false);
				setPhase(null);
				setLines((current) =>
					appendAssistantLine(
						current,
						error instanceof Error ? error.message : t("agent.failed"),
					),
				);
			}
		},
		[agentId, onSessionId, sending, t],
	);

	return {
		lines,
		sending,
		restoring,
		permission,
		phase,
		restore,
		send,
		clearSession,
		respondToPermission,
	};
}
