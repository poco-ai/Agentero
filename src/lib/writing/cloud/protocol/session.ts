import { HocuspocusProvider } from "@hocuspocus/provider";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import {
	type DurableAck,
	durableAck,
	type WritingSessionTicket,
	writingCheckpoint,
} from "./contracts.js";

export type WritingSessionOptions = {
	projectId: string;
	ticket: WritingSessionTicket;
	refreshTicket: () => Promise<WritingSessionTicket>;
	document?: Y.Doc;
	awareness?: Awareness;
	onClose?: (code: number) => void;
	onDurableAck?: (ack: DurableAck) => void;
	onStatus?: (status: "connecting" | "connected" | "disconnected") => void;
	onAuthenticationFailed?: (reason: string) => void;
};

export function connectWritingSession(options: WritingSessionOptions) {
	let ticket = options.ticket;
	let refresh: Promise<WritingSessionTicket> | null = null;
	async function getToken() {
		if (ticket.expiresAt * 1000 - Date.now() < 30_000) {
			refresh ??= options.refreshTicket().finally(() => {
				refresh = null;
			});
			ticket = await refresh;
		}
		return ticket.token;
	}

	const ownsDoc = !options.document;
	const document = options.document ?? new Y.Doc();
	const provider = new HocuspocusProvider({
		name: options.projectId,
		url: ticket.websocketUrl,
		document,
		awareness: options.awareness,
		onClose: ({ event }) => options.onClose?.(event.code),
		token: getToken,
		onStatus: ({ status }) => options.onStatus?.(status),
		onAuthenticationFailed: ({ reason }) =>
			options.onAuthenticationFailed?.(reason),
		onStateless: ({ payload }) => {
			try {
				const result = durableAck.safeParse(JSON.parse(payload));
				if (result.success && result.data.projectId === options.projectId)
					options.onDurableAck?.(result.data);
			} catch {
				// Other stateless messages are not save confirmations.
			}
		},
	});

	return {
		document,
		provider,
		getToken,
		replaceTicket(next: WritingSessionTicket) {
			if (
				next.websocketUrl !== ticket.websocketUrl ||
				next.serverUrl !== ticket.serverUrl
			)
				throw new Error("Writing service address changed");
			ticket = next;
		},
		/** Compare complete state, including pure deletions, against committed history. */
		async checkpoint(signal?: AbortSignal) {
			const state = Y.encodeStateAsUpdate(document);
			const token = await getToken();
			const response = await fetch(
				`${ticket.serverUrl}/v1/projects/${options.projectId}/checkpoint`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${token}`,
						"content-type": "application/octet-stream",
					},
					body: new Uint8Array(state),
					signal,
				},
			);
			if (!response.ok)
				throw new Error(`Writing checkpoint unavailable (${response.status})`);
			return writingCheckpoint.parse(await response.json());
		},
		destroy() {
			provider.destroy();
			if (ownsDoc) document.destroy();
		},
	};
}
