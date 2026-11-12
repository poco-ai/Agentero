/**
 * Interactive ACP surfaces: permission requests (ask mode), Codex
 * request_user_input elicitation, Grok ask_user_question, and the
 * tool-shaped ask promoted by the runtime.
 *
 * The permission dialog is modal and blocks global shortcuts. The docked
 * ask-user forms register on the overlay stack as non-modal so Esc can still
 * dismiss them via {@link closeTopOverlay}, but they do not steal shortcut
 * focus from the rest of the app.
 */
import { type Dispatch, type SetStateAction, useRef, useState } from "react";
import { useOverlayRegistration } from "@/hooks/use-overlay-registration";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import {
	type AskUserRequest,
	type ElicitationRequest,
	type PermissionRequest,
	respondAskUser,
	respondElicitation,
	respondPermission,
} from "@/lib/agent";
import type { ToolAskUserRequest } from "@/lib/agent/chat-state";
import { events } from "@/lib/core/bindings";
import { playCue } from "@/lib/ui/sound";

export type UseAgentPermissionSurfacesOptions = {
	toolAskUserRequest: ToolAskUserRequest | null;
	setToolAskUserRequest: Dispatch<SetStateAction<ToolAskUserRequest | null>>;
};

export type AgentPermissionSurfaces = {
	permissionRequest: PermissionRequest | null;
	setPermissionRequest: Dispatch<SetStateAction<PermissionRequest | null>>;
	elicitationRequest: ElicitationRequest | null;
	setElicitationRequest: Dispatch<SetStateAction<ElicitationRequest | null>>;
	askUserRequest: AskUserRequest | null;
	setAskUserRequest: Dispatch<SetStateAction<AskUserRequest | null>>;
};

export function useAgentPermissionSurfaces({
	toolAskUserRequest,
	setToolAskUserRequest,
}: UseAgentPermissionSurfacesOptions): AgentPermissionSurfaces {
	// Forward ACP permission requests (ask mode) to the user for an explicit decision.
	const [permissionRequest, setPermissionRequest] =
		useState<PermissionRequest | null>(null);
	// Codex Plan-mode request_user_input → form elicitation.
	const [elicitationRequest, setElicitationRequest] =
		useState<ElicitationRequest | null>(null);
	// Grok `_x.ai/ask_user_question` extension method.
	const [askUserRequest, setAskUserRequest] = useState<AskUserRequest | null>(
		null,
	);

	const permissionRequestRef = useRef(permissionRequest);
	permissionRequestRef.current = permissionRequest;
	useOverlayRegistration(
		"agent-permission",
		permissionRequest !== null,
		() => {
			const req = permissionRequestRef.current;
			if (!req) return;
			void respondPermission(req.requestId, null);
			setPermissionRequest(null);
		},
		{ modal: false },
	);

	const elicitationRequestRef = useRef(elicitationRequest);
	elicitationRequestRef.current = elicitationRequest;
	useOverlayRegistration(
		"agent-elicitation",
		elicitationRequest !== null,
		() => {
			const req = elicitationRequestRef.current;
			if (!req) return;
			void respondElicitation({
				requestId: req.requestId,
				action: "cancel",
			});
			setElicitationRequest(null);
		},
		{ modal: false },
	);

	const askUserRequestRef = useRef(askUserRequest);
	askUserRequestRef.current = askUserRequest;
	useOverlayRegistration(
		"agent-ask-user",
		askUserRequest !== null,
		() => {
			const req = askUserRequestRef.current;
			if (!req) return;
			void respondAskUser({
				requestId: req.requestId,
				action: "cancel",
			});
			setAskUserRequest(null);
		},
		{ modal: false },
	);

	const toolAskUserRequestRef = useRef(toolAskUserRequest);
	toolAskUserRequestRef.current = toolAskUserRequest;
	useOverlayRegistration(
		"agent-tool-ask-user",
		toolAskUserRequest !== null,
		() => {
			setToolAskUserRequest(null);
		},
		{ modal: false },
	);

	useTauriEvent(events.agentPermissionRequest, (payload) => {
		playCue("attention");
		setPermissionRequest(payload);
	});

	useTauriEvent(events.agentElicitationRequest, (payload) => {
		// Prefer host elicitation over tool-card promote.
		playCue("attention");
		setToolAskUserRequest(null);
		setElicitationRequest(payload);
	});

	useTauriEvent(events.agentAskUserRequest, (payload) => {
		// Grok ext is the authoritative respond path; drop tool-promote duplicate.
		playCue("attention");
		setToolAskUserRequest(null);
		setAskUserRequest(payload);
	});

	return {
		permissionRequest,
		setPermissionRequest,
		elicitationRequest,
		setElicitationRequest,
		askUserRequest,
		setAskUserRequest,
	};
}
