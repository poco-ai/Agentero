export type VoiceDefenseErrorCode =
	| "microphoneUnavailable"
	| "microphoneDenied"
	| "microphoneNotFound"
	| "microphoneBusy"
	| "dataChannelTimeout"
	| "dataChannelFailed"
	| "networkOffline"
	| "connectionLost"
	| "webrtcFailed";

export class VoiceDefenseError extends Error {
	constructor(
		readonly code: VoiceDefenseErrorCode,
		message = code,
	) {
		super(message);
		this.name = "VoiceDefenseError";
	}
}

function errorName(error: unknown): string {
	if (typeof error !== "object" || error === null || !("name" in error))
		return "";
	return String(error.name);
}

export function microphoneCaptureError(error: unknown): VoiceDefenseError {
	switch (errorName(error)) {
		case "NotAllowedError":
		case "PermissionDeniedError":
			return new VoiceDefenseError("microphoneDenied");
		case "NotFoundError":
		case "DevicesNotFoundError":
			return new VoiceDefenseError("microphoneNotFound");
		case "NotReadableError":
		case "TrackStartError":
			return new VoiceDefenseError("microphoneBusy");
		default:
			return new VoiceDefenseError("microphoneUnavailable");
	}
}

export function voiceDefenseErrorCode(
	error: unknown,
): VoiceDefenseErrorCode | null {
	return error instanceof VoiceDefenseError ? error.code : null;
}

export function voiceTransportErrorCode(
	state: RTCPeerConnectionState,
	online: boolean,
): VoiceDefenseErrorCode | null {
	switch (state) {
		case "disconnected":
			return online ? "connectionLost" : "networkOffline";
		case "failed":
			return "webrtcFailed";
		case "closed":
			return "connectionLost";
		default:
			return null;
	}
}
