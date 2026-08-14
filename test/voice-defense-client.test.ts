import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	VoiceDefenseClient,
	type VoiceDefenseClientEvents,
} from "@/lib/voice-defense/client";
import {
	upsertVoiceCaption,
	type VoiceCaption,
} from "@/lib/voice-defense/protocol";

type VoiceDefenseClientHarness = {
	channel: Pick<RTCDataChannel, "readyState" | "send"> | null;
	localStream: MediaStream | null;
	remoteStream: MediaStream | null;
	onDataMessage: (raw: unknown) => void;
	applyOpening: (next: {
		phase: "awaiting" | "open";
		heardOpening: boolean;
		voiceState: string | null;
	}) => void;
	handleOpeningTimeout: () => void;
	opening: {
		phase: "awaiting" | "open";
		heardOpening: boolean;
		voiceState: string | null;
	};
};

function voiceState(state: string) {
	return {
		type: "state_update",
		payload: { new_state: state },
	};
}

function assistantCaption(id: string, text: string) {
	return {
		type: "chat_message_delta",
		delta: {
			v: {
				message: {
					id,
					author: { role: "assistant" },
					content: { parts: [{ text }] },
				},
			},
		},
	};
}

function appendAssistantCaption(text: string) {
	return {
		type: "chat_message_delta",
		delta: {
			v: [
				{
					o: "append",
					p: "/message/content/parts/0/text",
					v: text,
				},
			],
		},
	};
}

function userCaption(id: string, text: string) {
	return {
		type: "chat_message_delta",
		delta: {
			v: {
				message: {
					id,
					author: { role: "user" },
					content: { parts: [{ text }] },
				},
			},
		},
	};
}

describe("voice defense client opening handshake", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.stubGlobal("window", {
			setTimeout,
			clearTimeout,
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("does not send a second opening trigger while the first turn caption is settling", () => {
		const sent: string[] = [];
		const captions: VoiceCaption[] = [];
		const events: VoiceDefenseClientEvents = {
			onStatus: () => undefined,
			onCaption: (caption) => captions.push(caption),
			onRemoteStream: () => undefined,
			onError: () => undefined,
		};
		const client = new VoiceDefenseClient(events);
		const harness = client as unknown as VoiceDefenseClientHarness;
		harness.channel = {
			readyState: "open",
			send: (data) => sent.push(String(data)),
		};

		// ChatGPT Web Voice can announce the opening in audio, return to
		// listening, and only then deliver the final transcription. Sending the
		// phase-two trigger at the listening edge makes it announce the opening a
		// second time.
		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(voiceState("listening"));

		vi.advanceTimersByTime(5_000);
		expect(sent).toEqual([]);

		harness.onDataMessage(
			assistantCaption(
				"opening-1",
				"答辩现在开始。你作为作者,先用两句话概括。我的第一个问题:你认为这项工作最关键的优势是什么?",
			),
		);
		vi.advanceTimersByTime(2_000);
		expect(sent).toEqual([]);
		expect(captions).toHaveLength(1);
	});

	it("sends the opening trigger after an acknowledgment caption settles", () => {
		const sent: string[] = [];
		const client = new VoiceDefenseClient({
			onStatus: () => undefined,
			onCaption: () => undefined,
			onRemoteStream: () => undefined,
			onError: () => undefined,
		});
		const harness = client as unknown as VoiceDefenseClientHarness;
		harness.channel = {
			readyState: "open",
			send: (data) => sent.push(String(data)),
		};

		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(voiceState("listening"));
		vi.advanceTimersByTime(5_000);
		harness.onDataMessage(assistantCaption("ack-1", "明白"));

		expect(sent).toEqual([]);
		vi.advanceTimersByTime(2_000);
		expect(sent).toHaveLength(1);
		expect(sent[0]).toContain("答辩现在开始");
	});

	it("cancels a pending trigger when a filler caption grows into the opening", () => {
		const sent: string[] = [];
		const captions: VoiceCaption[] = [];
		const client = new VoiceDefenseClient({
			onStatus: () => undefined,
			onCaption: (caption) => {
				const index = captions.findIndex((item) => item.id === caption.id);
				if (index === -1) captions.push(caption);
				else captions[index] = caption;
			},
			onRemoteStream: () => undefined,
			onError: () => undefined,
		});
		const harness = client as unknown as VoiceDefenseClientHarness;
		harness.channel = {
			readyState: "open",
			send: (data) => sent.push(String(data)),
		};

		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(assistantCaption("opening-1", "答辩"));
		harness.onDataMessage(voiceState("listening"));
		vi.advanceTimersByTime(500);
		harness.onDataMessage(
			appendAssistantCaption(
				"现在开始。我的第一个问题:这项工作的关键优势是什么?",
			),
		);
		vi.advanceTimersByTime(2_000);

		expect(sent).toEqual([]);
		expect(captions).toHaveLength(1);
		expect(captions[0]?.text).toContain("第一个问题");
	});

	it("nudges 答辩开始 without 现在 into the canonical first sentence", () => {
		const sent: string[] = [];
		const client = new VoiceDefenseClient({
			onStatus: () => undefined,
			onCaption: () => undefined,
			onRemoteStream: () => undefined,
			onError: () => undefined,
		});
		const harness = client as unknown as VoiceDefenseClientHarness;
		harness.channel = {
			readyState: "open",
			send: (data) => sent.push(String(data)),
		};

		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(assistantCaption("opening-1", "好的，答辩开始"));
		harness.onDataMessage(voiceState("listening"));
		vi.advanceTimersByTime(2_000);

		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			true,
		);
		expect(sent.some((payload) => payload.includes("答辩现在开始"))).toBe(true);
	});

	it("interrupts and retracts a second opening announcement from a live session", () => {
		const sent: string[] = [];
		let captions: VoiceCaption[] = [];
		const client = new VoiceDefenseClient({
			onStatus: () => undefined,
			onCaption: (caption) => {
				captions = upsertVoiceCaption(captions, caption);
			},
			onRemoteStream: () => undefined,
			onError: () => undefined,
		});
		const harness = client as unknown as VoiceDefenseClientHarness;
		harness.channel = {
			readyState: "open",
			send: (data) => sent.push(String(data)),
		};

		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(
			assistantCaption(
				"opening-1",
				"答辩现在开始。第一个问题:你们为什么认为可以完全去掉循环和卷积/卷积的瓶颈?或者说在非常长的序列上,自注意力的二次复杂度是O(n ²·d);长序列会削弱优势会被长序列挑战,但论文给出了可复现的细节,复现实验的",
			),
		);
		harness.onDataMessage(voiceState("listening"));
		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(assistantCaption("opening-2", "嗯"));
		harness.onDataMessage(
			appendAssistantCaption(
				",答辩现在开始。第一个问题:论文在Introduction里提到要摆脱 RNN 的顺序计算瓶颈。你认为他们替代循环或卷积的动机仅仅是为了并行训练,还是也关乎对长程依赖的建模能力?",
			),
		);

		expect(captions).toHaveLength(1);
		expect(captions[0]?.id).toBe("opening-1");
		expect(captions[0]?.text).toContain("答辩现在开始");
		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			true,
		);
		expect(sent.some((payload) => payload.includes("答辩现在开始。"))).toBe(
			false,
		);
	});

	it("refuses sendUserText until the opening gate is open", () => {
		const sent: string[] = [];
		const client = new VoiceDefenseClient({
			onStatus: () => undefined,
			onCaption: () => undefined,
			onRemoteStream: () => undefined,
			onError: () => undefined,
		});
		const harness = client as unknown as VoiceDefenseClientHarness;
		harness.channel = {
			readyState: "open",
			send: (data) => sent.push(String(data)),
		};

		expect(client.sendUserText("see table 2")).toBe(false);
		expect(sent).toEqual([]);

		harness.opening = {
			phase: "open",
			heardOpening: true,
			voiceState: "listening",
		};
		expect(client.sendUserText("   ")).toBe(false);
		expect(client.sendUserText("see table 2")).toBe(true);
		expect(sent.some((payload) => payload.includes("see table 2"))).toBe(true);
	});

	it("keeps committee audio muted until the defense is announced", () => {
		const sent: string[] = [];
		const playback: boolean[] = [];
		let captions: VoiceCaption[] = [];
		const remoteTrack = { enabled: true };
		const client = new VoiceDefenseClient({
			onStatus: () => undefined,
			onCaption: (caption) => {
				captions = upsertVoiceCaption(captions, caption);
			},
			onRemoteStream: () => undefined,
			onCommitteePlayback: (enabled) => playback.push(enabled),
			onError: () => undefined,
		});
		const harness = client as unknown as VoiceDefenseClientHarness;
		harness.channel = {
			readyState: "open",
			send: (data) => sent.push(String(data)),
		};
		harness.remoteStream = {
			getAudioTracks: () => [remoteTrack],
			getTracks: () => [remoteTrack],
		} as unknown as MediaStream;

		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(
			assistantCaption(
				"preamble",
				"机制的设计理由是什么？为什么注意力就足以替代循环和卷积网络？",
			),
		);
		expect(captions).toEqual([]);
		expect(remoteTrack.enabled).toBe(false);
		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			true,
		);

		harness.onDataMessage(voiceState("listening"));
		vi.advanceTimersByTime(1_000);
		expect(
			sent.some((payload) => payload.includes("请用「答辩现在开始。」")),
		).toBe(true);
		expect(remoteTrack.enabled).toBe(false);

		harness.onDataMessage(voiceState("speaking"));
		expect(remoteTrack.enabled).toBe(false);
		expect(captions).toEqual([]);

		harness.onDataMessage(
			assistantCaption(
				"opening",
				"答辩现在开始。第一个问题:为什么注意力就足以替代循环和卷积网络？",
			),
		);
		expect(captions).toHaveLength(1);
		expect(captions[0]?.id).toBe("opening");
		expect(remoteTrack.enabled).toBe(true);
		expect(playback.at(-1)).toBe(true);
	});

	it("does not surface a stale noncanonical first turn when the blind timeout expires", () => {
		const sent: string[] = [];
		const playback: boolean[] = [];
		let captions: VoiceCaption[] = [];
		const remoteTrack = { enabled: true };
		const client = new VoiceDefenseClient({
			onStatus: () => undefined,
			onCaption: (caption) => {
				captions = upsertVoiceCaption(captions, caption);
			},
			onRemoteStream: () => undefined,
			onCommitteePlayback: (enabled) => playback.push(enabled),
			onError: () => undefined,
		});
		const harness = client as unknown as VoiceDefenseClientHarness;
		harness.channel = {
			readyState: "open",
			send: (data) => sent.push(String(data)),
		};
		harness.remoteStream = {
			getAudioTracks: () => [remoteTrack],
			getTracks: () => [remoteTrack],
		} as unknown as MediaStream;

		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(
			assistantCaption(
				"real-preamble",
				"好的,我们来聚焦他们的核心主张。我想问,你在形式化范式层面如何看待它对跨组件依赖的处理。",
			),
		);
		expect(captions).toEqual([]);
		expect(remoteTrack.enabled).toBe(false);

		harness.handleOpeningTimeout();
		harness.onDataMessage(voiceState("listening"));

		expect(harness.opening.phase).toBe("awaiting");
		expect(captions).toEqual([]);
		expect(remoteTrack.enabled).toBe(false);
		expect(playback.at(-1)).not.toBe(true);
		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			true,
		);
		expect(sent.some((payload) => payload.includes("答辩现在开始"))).toBe(true);

		harness.onDataMessage(
			assistantCaption(
				"prefixed-recovery",
				"嗯。答辩现在开始。第一个问题：请解释时间可组合性。",
			),
		);
		expect(harness.opening.phase).toBe("awaiting");
		expect(captions).toEqual([]);
		expect(remoteTrack.enabled).toBe(false);
	});

	it("drops noise ASR and interrupts a first-question reask before any real answer", () => {
		const sent: string[] = [];
		let captions: VoiceCaption[] = [];
		const client = new VoiceDefenseClient({
			onStatus: () => undefined,
			onCaption: (caption) => {
				captions = upsertVoiceCaption(captions, caption);
			},
			onRemoteStream: () => undefined,
			onError: () => undefined,
		});
		const harness = client as unknown as VoiceDefenseClientHarness;
		harness.channel = {
			readyState: "open",
			send: (data) => sent.push(String(data)),
		};

		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(
			assistantCaption(
				"q1",
				"答辩现在开始。机制的设计理由是什么？为什么注意力就足以替代循环和卷积网络？",
			),
		);
		harness.onDataMessage(voiceState("listening"));
		harness.onDataMessage(userCaption("u1", "You So Mmm. Tsk"));
		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(
			assistantCaption(
				"q1-again",
				"我问第一个问题:论文为什么认为必须去掉循环和卷积,而仅用注意力?如果序列很长呢?用它的自注意力,相较于循环层",
			),
		);

		expect(captions).toHaveLength(1);
		expect(captions[0]?.id).toBe("q1");
		expect(captions[0]?.text).toContain("机制的设计理由");
		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			true,
		);
		expect(
			sent.some((payload) => payload.includes("请用「答辩现在开始。」")),
		).toBe(false);
	});

	it("keeps a first-question follow-up after a real spoken answer", () => {
		const sent: string[] = [];
		let captions: VoiceCaption[] = [];
		const client = new VoiceDefenseClient({
			onStatus: () => undefined,
			onCaption: (caption) => {
				captions = upsertVoiceCaption(captions, caption);
			},
			onRemoteStream: () => undefined,
			onError: () => undefined,
		});
		const harness = client as unknown as VoiceDefenseClientHarness;
		harness.channel = {
			readyState: "open",
			send: (data) => sent.push(String(data)),
		};

		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(
			assistantCaption(
				"q1",
				"答辩现在开始。机制的设计理由是什么？为什么注意力就足以替代循环和卷积网络？",
			),
		);
		harness.onDataMessage(voiceState("listening"));
		harness.onDataMessage(
			userCaption("u1", "因为自注意力可以直接建模任意距离的依赖。"),
		);
		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(
			assistantCaption("follow", "回到第一个问题，你刚才的回答漏了假设。"),
		);

		expect(captions.map((caption) => caption.id)).toEqual([
			"q1",
			"u1",
			"follow",
		]);
		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			false,
		);
	});

	it("keeps the microphone disabled for a settle delay after the gate opens", () => {
		const track = { enabled: true };
		const client = new VoiceDefenseClient({
			onStatus: () => undefined,
			onCaption: () => undefined,
			onRemoteStream: () => undefined,
			onError: () => undefined,
		});
		const harness = client as unknown as VoiceDefenseClientHarness;
		harness.channel = {
			readyState: "open",
			send: () => undefined,
		};
		harness.localStream = {
			getAudioTracks: () => [track],
			getTracks: () => [track],
		} as unknown as MediaStream;

		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(
			assistantCaption(
				"q1",
				"答辩现在开始。机制的设计理由是什么？为什么注意力就足以替代循环和卷积网络？",
			),
		);
		harness.onDataMessage(voiceState("listening"));
		expect(track.enabled).toBe(false);
		vi.advanceTimersByTime(399);
		expect(track.enabled).toBe(false);
		vi.advanceTimersByTime(1);
		expect(track.enabled).toBe(true);
	});
});
