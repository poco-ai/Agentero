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
	internalCaptionTexts: string[];
	microphoneSettled: boolean;
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
		harness.onDataMessage(assistantCaption("ack-1", "好的，我已了解背景"));

		expect(sent).toEqual([]);
		vi.advanceTimersByTime(2_000);
		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			true,
		);
		expect(sent.some((payload) => payload.includes("答辩现在开始"))).toBe(true);
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

	it("accepts 答辩开始 without 现在 and does not recover", () => {
		const sent: string[] = [];
		const captions: VoiceCaption[] = [];
		const playback: boolean[] = [];
		const remoteTrack = { enabled: true };
		const client = new VoiceDefenseClient({
			onStatus: () => undefined,
			onCaption: (caption) => captions.push(caption),
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
				"opening-1",
				"好的，答辩开始。第一个问题：论文为什么认为仅用注意力替代循环和卷积是值得做的?",
			),
		);
		harness.onDataMessage(voiceState("listening"));
		vi.advanceTimersByTime(2_000);

		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			false,
		);
		expect(sent.some((payload) => payload.includes("答辩现在开始"))).toBe(
			false,
		);
		expect(captions).toHaveLength(1);
		expect(remoteTrack.enabled).toBe(true);
		expect(playback.at(-1)).toBe(true);
	});

	it("replays the 21:02 wire first question with U+FFFD and does not recover", () => {
		const sent: string[] = [];
		let captions: VoiceCaption[] = [];
		const remoteTrack = { enabled: true };
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
		harness.remoteStream = {
			getAudioTracks: () => [remoteTrack],
			getTracks: () => [remoteTrack],
		} as unknown as MediaStream;

		// Tonight's log stayed on listening for the whole first turn.
		harness.onDataMessage(voiceState("listening"));
		harness.onDataMessage(assistantCaption("wire-2102", "答"));
		expect(captions).toEqual([]);
		expect(sent).toEqual([]);
		harness.onDataMessage(appendAssistantCaption("\uFFFD开始。"));
		vi.advanceTimersByTime(200);
		harness.onDataMessage(
			appendAssistantCaption("第一个问题: 你认为,用纯注意力替代RNN"),
		);
		vi.advanceTimersByTime(2_000);

		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			false,
		);
		expect(sent.some((payload) => payload.includes("答辩现在开始"))).toBe(
			false,
		);
		expect(captions).toHaveLength(1);
		expect(captions[0]?.text).toContain("第一个问题");
		expect(remoteTrack.enabled).toBe(true);
		expect(harness.opening.heardOpening).toBe(true);
	});

	it("does not interrupt or recover while the opening caption is still streaming", () => {
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

		harness.onDataMessage(voiceState("listening"));
		harness.onDataMessage(assistantCaption("opening-1", "答"));
		vi.advanceTimersByTime(500);
		expect(sent).toEqual([]);
		harness.onDataMessage(appendAssistantCaption("辩现在"));
		vi.advanceTimersByTime(500);
		expect(sent).toEqual([]);
		harness.onDataMessage(appendAssistantCaption("开始。第一个问题"));
		vi.advanceTimersByTime(2_000);

		expect(sent).toEqual([]);
		expect(captions).toHaveLength(1);
		expect(captions[0]?.text).toContain("第一个问题");
		expect(harness.opening.heardOpening).toBe(true);
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

	it("unmutes the recovery opening from the first word after a muted preamble", () => {
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
		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			true,
		);
		expect(remoteTrack.enabled).toBe(false);

		harness.onDataMessage(voiceState("speaking"));
		expect(remoteTrack.enabled).toBe(false);
		expect(captions).toEqual([]);

		harness.onDataMessage(assistantCaption("opening", "嗯"));
		expect(captions).toEqual([]);
		expect(remoteTrack.enabled).toBe(false);

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
		expect(harness.opening.heardOpening).toBe(true);
		expect(captions).toHaveLength(1);
		expect(captions[0]?.id).toBe("prefixed-recovery");
		expect(remoteTrack.enabled).toBe(true);
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

	it("still interrupts a re-announcement after the user has answered", () => {
		const sent: string[] = [];
		let captions: VoiceCaption[] = [];
		const remoteTrack = { enabled: true };
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
		harness.remoteStream = {
			getAudioTracks: () => [remoteTrack],
			getTracks: () => [remoteTrack],
		} as unknown as MediaStream;

		// 2026-08-15 19:56 wire replay: the committee re-announced and
		// re-asked the first question after a short user reaction. A real
		// answer must not disarm the re-announcement guard.
		harness.onDataMessage(voiceState("listening"));
		harness.onDataMessage(
			assistantCaption("q1", "答辩现在开始。第一个问题：动机是什么？"),
		);
		harness.onDataMessage(voiceState("listening"));
		harness.onDataMessage(
			userCaption("u1", "因为自注意力可以直接建模任意距离的依赖。"),
		);
		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(
			assistantCaption("q1-again", "答辩现在开始。第一个问题：动机是什么？"),
		);

		expect(captions.map((caption) => caption.id)).toEqual(["q1", "u1"]);
		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			true,
		);
		expect(remoteTrack.enabled).toBe(false);
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
		vi.advanceTimersByTime(1_199);
		expect(track.enabled).toBe(false);
		vi.advanceTimersByTime(1);
		expect(track.enabled).toBe(true);
	});

	it("keeps the microphone closed while the first question caption is still growing", () => {
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

		harness.onDataMessage(voiceState("listening"));
		harness.onDataMessage(assistantCaption("q1", "嗯,答辩现在开始"));
		expect(track.enabled).toBe(false);
		vi.advanceTimersByTime(800);
		harness.onDataMessage(
			assistantCaption("q1", "嗯,答辩现在开始。好,那我就直接提问。"),
		);
		vi.advanceTimersByTime(1_199);
		expect(track.enabled).toBe(false);
		vi.advanceTimersByTime(1);
		expect(track.enabled).toBe(true);
	});

	it("plays a follow-up from its first token and only interrupts a confirmed re-announcement", () => {
		const sent: string[] = [];
		let captions: VoiceCaption[] = [];
		const remoteTrack = { enabled: true };
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
		harness.remoteStream = {
			getAudioTracks: () => [remoteTrack],
			getTracks: () => [remoteTrack],
		} as unknown as MediaStream;

		harness.onDataMessage(voiceState("listening"));
		harness.onDataMessage(
			assistantCaption(
				"9e6b47b8",
				"嗯,答辩现在开始。好,那我就直接提问。首先,你在讲多头注意力的时候",
			),
		);
		expect(remoteTrack.enabled).toBe(true);
		expect(captions).toHaveLength(1);

		// A filler token usually opens a normal follow-up; interrupting it
		// here taught the model to restart the defense and re-ask the first
		// question, so the suspect window must stay audible and captioned.
		harness.onDataMessage(assistantCaption("e4071db8", "嗯"));
		expect(remoteTrack.enabled).toBe(true);
		expect(captions.map((caption) => caption.id)).toEqual([
			"9e6b47b8",
			"e4071db8",
		]);
		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			false,
		);

		harness.onDataMessage(
			assistantCaption("e4071db8", "嗯...答辩现在开始。第一个问题:论文说 RNN"),
		);
		expect(remoteTrack.enabled).toBe(false);
		expect(captions.map((caption) => caption.id)).toEqual(["9e6b47b8"]);
		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			true,
		);
	});

	it("keeps a split first question that starts with why before the user has answered", () => {
		const sent: string[] = [];
		let captions: VoiceCaption[] = [];
		const remoteTrack = { enabled: true };
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
		harness.remoteStream = {
			getAudioTracks: () => [remoteTrack],
			getTracks: () => [remoteTrack],
		} as unknown as MediaStream;

		harness.onDataMessage(voiceState("listening"));
		harness.onDataMessage(
			assistantCaption(
				"opening",
				"答辩现在开始。第一个问题：论文第1节和第4节指出 Transformer 提出完全基于注意力的架构。",
			),
		);
		harness.onDataMessage(assistantCaption("question-tail", "为什么"));

		expect(captions.map((caption) => caption.id)).toEqual([
			"opening",
			"question-tail",
		]);
		expect(remoteTrack.enabled).toBe(true);
		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			false,
		);
	});

	it("keeps a delayed committee append out of a material-echo user caption", () => {
		const captions: VoiceCaption[] = [];
		const client = new VoiceDefenseClient({
			onStatus: () => undefined,
			onCaption: (caption) => {
				const index = captions.findIndex((item) => item.id === caption.id);
				if (caption.text.trim() === "") {
					if (index !== -1) captions.splice(index, 1);
					return;
				}
				if (index === -1) captions.push(caption);
				else captions[index] = caption;
			},
			onRemoteStream: () => undefined,
			onError: () => undefined,
		});
		const harness = client as unknown as VoiceDefenseClientHarness;
		harness.channel = {
			readyState: "open",
			send: () => undefined,
		};
		harness.opening = {
			phase: "open",
			heardOpening: true,
			voiceState: "speaking",
		};
		harness.internalCaptionTexts = [
			"The need-Paper you pdf而是 section compares the recursive baseline.",
		];
		harness.microphoneSettled = true;

		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(
			assistantCaption("committee-1", "好,答辩现在开始。第一个问题是"),
		);
		harness.onDataMessage(userCaption("user-echo-1", "need-Paper you pdf而是"));
		harness.onDataMessage(appendAssistantCaption("?为什么要去掉递归层"));

		expect(captions).toEqual([
			{
				id: "committee-1",
				role: "assistant",
				text: "好,答辩现在开始。第一个问题是?为什么要去掉递归层",
			},
		]);
	});

	it("does not lock a recovered preamble that later grows into a first question", () => {
		const sent: string[] = [];
		let captions: VoiceCaption[] = [];
		const remoteTrack = { enabled: true };
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
		harness.remoteStream = {
			getAudioTracks: () => [remoteTrack],
			getTracks: () => [remoteTrack],
		} as unknown as MediaStream;

		harness.onDataMessage(voiceState("speaking"));
		harness.onDataMessage(assistantCaption("ack-1", "好的，我已了解背景"));
		harness.onDataMessage(voiceState("listening"));
		vi.advanceTimersByTime(1_000);
		expect(sent.some((payload) => payload.includes("答辩现在开始"))).toBe(true);
		expect(remoteTrack.enabled).toBe(false);
		expect(captions).toEqual([]);

		harness.onDataMessage(
			assistantCaption(
				"ack-1",
				"好的，我已了解背景。第一个问题：机制的设计理由是什么？",
			),
		);
		expect(captions).toEqual([]);
		expect(remoteTrack.enabled).toBe(false);
		expect(harness.opening.heardOpening).toBe(false);

		harness.onDataMessage(
			assistantCaption(
				"opening",
				"嗯。答辩现在开始。第一个问题：机制的设计理由是什么？",
			),
		);
		expect(captions).toHaveLength(1);
		expect(captions[0]?.id).toBe("opening");
		expect(captions[0]?.text).toContain("答辩现在开始");
		expect(remoteTrack.enabled).toBe(true);
		expect(harness.opening.heardOpening).toBe(true);
		expect(
			sent.filter((payload) => payload.includes("stop_speaking")),
		).toHaveLength(1);
	});

	it("accepts a 好-comma announcement without recovering", () => {
		const sent: string[] = [];
		let captions: VoiceCaption[] = [];
		const remoteTrack = { enabled: true };
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
		harness.remoteStream = {
			getAudioTracks: () => [remoteTrack],
			getTracks: () => [remoteTrack],
		} as unknown as MediaStream;

		harness.onDataMessage(voiceState("listening"));
		harness.onDataMessage(
			assistantCaption(
				"ae939ed7",
				"好,答辩现在开始。你在「关键假设」里,你提到的",
			),
		);
		expect(captions).toHaveLength(1);
		expect(captions[0]?.text).toContain("答辩现在开始");
		expect(remoteTrack.enabled).toBe(true);
		expect(harness.opening.heardOpening).toBe(true);
		vi.advanceTimersByTime(20_000);
		expect(sent.some((payload) => payload.includes("请用「答辩现在开始"))).toBe(
			false,
		);
	});

	it("does not recover while a peeled announcement is still growing", () => {
		const sent: string[] = [];
		let captions: VoiceCaption[] = [];
		const remoteTrack = { enabled: true };
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
		harness.remoteStream = {
			getAudioTracks: () => [remoteTrack],
			getTracks: () => [remoteTrack],
		} as unknown as MediaStream;

		harness.onDataMessage(voiceState("listening"));
		harness.onDataMessage(assistantCaption("016cf65e", "嗯。答辩"));
		harness.handleOpeningTimeout();
		expect(sent.some((payload) => payload.includes("请用「答辩现在开始"))).toBe(
			false,
		);
		harness.onDataMessage(
			assistantCaption(
				"016cf65e",
				"嗯。答辩现在开始。第一个问题：机制的设计理由是什么？",
			),
		);
		expect(captions).toHaveLength(1);
		expect(captions[0]?.id).toBe("016cf65e");
		expect(remoteTrack.enabled).toBe(true);
		expect(harness.opening.heardOpening).toBe(true);
	});

	it("does not let a late first-question caption lock the recovery announcement", () => {
		const sent: string[] = [];
		let captions: VoiceCaption[] = [];
		const remoteTrack = { enabled: true };
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
		harness.remoteStream = {
			getAudioTracks: () => [remoteTrack],
			getTracks: () => [remoteTrack],
		} as unknown as MediaStream;

		harness.onDataMessage(voiceState("listening"));
		harness.onDataMessage(
			assistantCaption(
				"7d117576",
				"你没法保证完全公平。比如说训练 FLOPs, 在序列长度可能更快注意力是在解决",
			),
		);
		vi.advanceTimersByTime(1_000);
		expect(sent.some((payload) => payload.includes("答辩现在开始"))).toBe(true);
		expect(remoteTrack.enabled).toBe(false);

		harness.onDataMessage(
			assistantCaption("37ce9d8b", "第一个问题:你能解释训练开销吗？"),
		);
		expect(captions).toEqual([]);
		expect(remoteTrack.enabled).toBe(false);
		expect(harness.opening.heardOpening).toBe(false);

		harness.onDataMessage(assistantCaption("8104f4a9", "答"));
		expect(captions).toEqual([]);
		harness.onDataMessage(
			assistantCaption("8104f4a9", "答辩现在开始。第一个问题:结合论文 Table 2"),
		);
		expect(captions).toHaveLength(1);
		expect(captions[0]?.id).toBe("8104f4a9");
		expect(captions[0]?.text).toContain("答辩现在开始");
		expect(remoteTrack.enabled).toBe(true);
		expect(harness.opening.heardOpening).toBe(true);
		expect(sent.some((payload) => payload.includes("stop_speaking"))).toBe(
			true,
		);
		expect(
			sent.filter((payload) => payload.includes("stop_speaking")).length,
		).toBeLessThan(3);
	});
});
