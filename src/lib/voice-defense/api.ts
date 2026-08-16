import { invokeApi } from "@/lib/core/ipc";

export const VOICE_AUTH_CHANGED_EVENT = "voice-auth:changed";

export type VoiceAuthStatus = {
	connected: boolean;
	connecting: boolean;
	error?: string | null;
};

export type VoiceConfig = {
	defaults: {
		voice: string;
		voice_mode: string;
		language_code: string;
	};
	webrtc: {
		data_channel: {
			label: string;
			negotiated: boolean;
			id: number;
		};
		ice_servers: RTCIceServer[];
		receive_audio: boolean;
		receive_video?: boolean;
	};
};

export type VoiceSessionRequest = {
	offerSdp: string;
	voice: string;
	voiceMode: string;
	languageCode: string;
};

export type VoiceSessionResponse = {
	answerSdp: string;
	voiceSessionId: string;
};

export async function getVoiceAuthStatus(): Promise<VoiceAuthStatus> {
	return invokeApi<VoiceAuthStatus>("voice_auth_status", undefined, {
		fallback: "Could not read ChatGPT connection status",
	});
}

export async function connectVoiceAuth(
	title: string,
): Promise<VoiceAuthStatus> {
	return invokeApi<VoiceAuthStatus>(
		"voice_auth_connect",
		{ title },
		{ fallback: "Could not open ChatGPT login" },
	);
}

export async function cancelVoiceAuth(): Promise<VoiceAuthStatus> {
	return invokeApi<VoiceAuthStatus>("voice_auth_cancel", undefined, {
		fallback: "Could not cancel ChatGPT login",
	});
}

export async function disconnectVoiceAuth(): Promise<VoiceAuthStatus> {
	return invokeApi<VoiceAuthStatus>("voice_auth_disconnect", undefined, {
		fallback: "Could not disconnect ChatGPT",
	});
}

export function describeVoiceAuthError(
	message: string,
	ownerConflict: string,
): string {
	return /invalid attempt to change the owner of this item|keychain owner conflict/i.test(
		message,
	)
		? ownerConflict
		: message;
}

export async function getVoiceConfig(): Promise<VoiceConfig> {
	return invokeApi<VoiceConfig>("voice_config", undefined, {
		fallback: "Voice configuration failed",
	});
}

export async function createVoiceSession(
	request: VoiceSessionRequest,
): Promise<VoiceSessionResponse> {
	return invokeApi<VoiceSessionResponse>(
		"voice_session_create",
		{ request },
		{ fallback: "Voice session failed" },
	);
}

export async function releaseVoiceSession(
	voiceSessionId: string,
): Promise<void> {
	await invokeApi<{ released: boolean }>(
		"voice_session_release",
		{ voiceSessionId },
		{ fallback: "Voice session release failed" },
	);
}
