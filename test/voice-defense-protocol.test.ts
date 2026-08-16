import { describe, expect, it } from "vitest";
import { combineVoiceDefenseContext } from "@/lib/voice-defense/context";
import {
	microphoneCaptureError,
	VoiceDefenseError,
	voiceDefenseErrorCode,
	voiceTransportErrorCode,
} from "@/lib/voice-defense/errors";
import {
	applyVoiceCaptionDelta,
	buildDefenseBootstrap,
	buildDefenseContextPatch,
	buildDefenseOpeningTrigger,
	buildDefenseRefocusPrompt,
	buildVoiceInterruptEvent,
	buildVoiceRelayEvent,
	createVoiceOpeningState,
	encodeVoiceEvent,
	isAcceptableDefenseAnnouncementCaption,
	isAcceptableDefenseOpeningCaption,
	isCanonicalDefenseAnnouncementCaption,
	isDefenseAnnouncementCaption,
	isDefenseOpeningCaption,
	isDefenseRestartCaption,
	isFirstQuestionReaskCaption,
	isGrowingDefenseAnnouncementCaption,
	isNoiseUserCaption,
	isOpeningFillerCaption,
	isPureOpeningAckCaption,
	isSubstantialUserCaption,
	reduceVoiceOpening,
	unwrapVoiceMessage,
	upsertVoiceCaption,
	VoiceCaptionStream,
	visibleAssistantCaptionDuringOpening,
	visibleVoiceCaption,
	voiceStateFromMessage,
} from "@/lib/voice-defense/protocol";
import {
	buildVoiceTranscriptMarkdown,
	voiceTranscriptFileName,
} from "@/lib/voice-defense/transcript";

function delta(message: Record<string, unknown>) {
	return {
		type: "chat_message_delta",
		delta: { v: { message } },
	};
}

describe("voice defense protocol", () => {
	it("keeps long defense material without an application-side truncation", () => {
		const notes = `${"method and evidence. ".repeat(1_000)}END-OF-NOTES`;
		const context = combineVoiceDefenseContext("selected claim", notes);

		expect(context.length).toBeGreaterThan(12_000);
		expect(context).toContain("selected claim");
		expect(context.endsWith("END-OF-NOTES")).toBe(true);
	});

	it("classifies microphone failures without exposing browser error text", () => {
		expect(microphoneCaptureError({ name: "NotAllowedError" }).code).toBe(
			"microphoneDenied",
		);
		expect(microphoneCaptureError({ name: "NotFoundError" }).code).toBe(
			"microphoneNotFound",
		);
		expect(microphoneCaptureError({ name: "NotReadableError" }).code).toBe(
			"microphoneBusy",
		);
		expect(microphoneCaptureError(new Error("raw browser error")).code).toBe(
			"microphoneUnavailable",
		);
		expect(voiceDefenseErrorCode(new VoiceDefenseError("networkOffline"))).toBe(
			"networkOffline",
		);
		expect(voiceDefenseErrorCode(new Error("untyped"))).toBeNull();
		expect(voiceTransportErrorCode("disconnected", false)).toBe(
			"networkOffline",
		);
		expect(voiceTransportErrorCode("disconnected", true)).toBe(
			"connectionLost",
		);
		expect(voiceTransportErrorCode("connected", true)).toBeNull();
	});

	it("wraps and unwraps data messages", () => {
		const event = buildVoiceInterruptEvent();
		const wrapped = encodeVoiceEvent(event);
		expect(unwrapVoiceMessage(wrapped)).toEqual(event);
	});

	it("builds a user relay message with defense content", () => {
		const event = buildVoiceRelayEvent("Ask about the experiment.");
		expect(event.type).toBe("relay_message");
		expect(
			(event.payload as { message: { content: { parts: string[] } } }).message
				.content.parts[0],
		).toBe("Ask about the experiment.");
	});

	it("hides the internal defense bootstrap when upstream echoes it", () => {
		const bootstrapId = "agentero-bootstrap";
		const bootstrap =
			"你现在是论文答辩委员会委员。\n\n请根据以下材料进行答辩，每次只提出一个问题。\n\n答辩材料：\n集合";
		const event = buildVoiceRelayEvent(bootstrap, bootstrapId);
		const message = (event.payload as { message: Record<string, unknown> })
			.message;
		const caption = applyVoiceCaptionDelta(null, delta(message));

		expect(caption).toMatchObject({
			id: bootstrapId,
			role: "user",
			text: bootstrap,
		});
		expect(
			visibleVoiceCaption(caption, {
				messageIds: new Set([bootstrapId]),
				texts: [bootstrap],
			}),
		).toBeNull();
		expect(
			visibleVoiceCaption(
				{
					id: "upstream-rewritten",
					role: "user",
					text: bootstrap.slice(0, 40),
				},
				{ messageIds: new Set(), texts: [bootstrap] },
			),
		).toBeNull();
		expect(
			visibleVoiceCaption(
				{ id: "oral-answer", role: "user", text: "你现在怎么看" },
				{ messageIds: new Set(), texts: [bootstrap] },
			),
		).toMatchObject({ id: "oral-answer" });
	});

	it("maps state updates", () => {
		expect(
			voiceStateFromMessage({
				type: "data_message",
				data: JSON.stringify({
					type: "state_update",
					payload: { new_state: "speaking" },
				}),
			}),
		).toBe("speaking");
		expect(
			voiceStateFromMessage({
				type: "state_update_envelope",
				payload: { type: "state_update", new_state: "listening" },
			}),
		).toBe("listening");
	});

	it("parses full and append caption deltas", () => {
		const first = applyVoiceCaptionDelta(
			null,
			delta({
				id: "m1",
				author: { role: "assistant" },
				content: { parts: [{ text: "Why this method?" }] },
			}),
		);
		expect(first).toEqual({
			id: "m1",
			role: "assistant",
			text: "Why this method?",
		});
		const appended = applyVoiceCaptionDelta(first, {
			type: "chat_message_delta",
			delta: {
				v: [
					{ o: "append", p: "/message/content/parts/0/text", v: " Explain." },
				],
			},
		});
		expect(appended?.text).toBe("Why this method? Explain.");
		const garbled = applyVoiceCaptionDelta(
			applyVoiceCaptionDelta(
				null,
				delta({
					id: "m2",
					author: { role: "assistant" },
					content: { parts: [{ text: "答" }] },
				}),
			),
			{
				type: "chat_message_delta",
				delta: {
					v: [
						{
							o: "append",
							p: "/message/content/parts/0/text",
							v: "\uFFFD开始。第一个问题: 你认为",
						},
					],
				},
			},
		);
		expect(garbled?.text).toBe("答开始。第一个问题: 你认为");
		expect(isAcceptableDefenseOpeningCaption(garbled?.text ?? "")).toBe(true);
	});

	it("keeps the append target when an empty frame for another message interleaves", () => {
		const streaming = applyVoiceCaptionDelta(
			null,
			delta({
				id: "assistant-1",
				author: { role: "assistant" },
				content: { parts: [{ text: "Why this baseline" }] },
			}),
		);
		// A user transcription slot opens mid-stream with no text yet.
		const afterEmptyFrame = applyVoiceCaptionDelta(
			streaming,
			delta({
				id: "user-1",
				author: { role: "user" },
				content: { parts: [] },
			}),
		);
		expect(afterEmptyFrame).toBe(streaming);
		// The assistant's append still lands on the assistant caption.
		const appended = applyVoiceCaptionDelta(afterEmptyFrame, {
			type: "chat_message_delta",
			delta: {
				v: [{ o: "append", p: "/message/content/parts/0/text", v: "?" }],
			},
		});
		expect(appended).toEqual({
			id: "assistant-1",
			role: "assistant",
			text: "Why this baseline?",
		});
		// A user frame that actually carries text takes over normally.
		const userSpoke = applyVoiceCaptionDelta(
			appended,
			delta({
				id: "user-1",
				author: { role: "user" },
				content: { parts: [{ text: "Because it is standard." }] },
			}),
		);
		expect(userSpoke).toEqual({
			id: "user-1",
			role: "user",
			text: "Because it is standard.",
		});
	});

	it("does not append a delayed committee delta to an interleaved user caption", () => {
		const stream = new VoiceCaptionStream();
		stream.apply(
			delta({
				id: "committee-1",
				author: { role: "assistant" },
				content: { parts: [{ text: "好,答辩现在开始。第一个问题是" }] },
			}),
		);
		stream.apply(
			delta({
				id: "user-echo-1",
				author: { role: "user" },
				content: { parts: [{ text: "need-Paper you pdf" }] },
			}),
		);
		// The upstream patch has no message id. It must still target the
		// assistant stream that was active before the user ASR slot appeared.
		const continuedCommittee = stream.apply(
			{
				type: "chat_message_delta",
				delta: {
					v: [
						{
							o: "append",
							p: "/message/content/parts/0/text",
							v: "?为什么要去掉递归层",
						},
					],
				},
			},
			{ voiceState: "speaking", preferAssistant: true },
		);

		expect(continuedCommittee).toEqual({
			id: "committee-1",
			role: "assistant",
			text: "好,答辩现在开始。第一个问题是?为什么要去掉递归层",
		});
	});

	it("keeps delayed assistant appends on the assistant stream at the listening edge", () => {
		const stream = new VoiceCaptionStream();
		stream.apply(
			delta({
				id: "committee-1",
				author: { role: "assistant" },
				content: { parts: [{ text: "第一个问题：为什么" }] },
			}),
		);
		stream.apply(
			delta({
				id: "user-echo-1",
				author: { role: "user" },
				content: { parts: [{ text: "need-Paper you pdf" }] },
			}),
		);

		const continued = stream.apply(
			{
				type: "chat_message_delta",
				delta: {
					v: [
						{
							o: "append",
							p: "/message/content/parts/0/text",
							v: "要去掉递归层？",
						},
					],
				},
			},
			{ voiceState: "listening", preferAssistant: true },
		);

		expect(continued?.id).toBe("committee-1");
		expect(continued?.text).toBe("第一个问题：为什么要去掉递归层？");
	});

	it("honors an explicit append id and drops an unknown id instead of guessing", () => {
		const stream = new VoiceCaptionStream();
		stream.apply(
			delta({
				id: "assistant-1",
				author: { role: "assistant" },
				content: { parts: [{ text: "Why this baseline" }] },
			}),
		);
		stream.apply({
			type: "chat_message_delta",
			delta: {
				message_id: "assistant-1",
				v: [
					{
						o: "append",
						p: "/message/content/parts/0/text",
						v: "?",
					},
				],
			},
		});
		expect(
			stream.apply({
				type: "chat_message_delta",
				delta: {
					message_id: "missing-message",
					v: [
						{
							o: "append",
							p: "/message/content/parts/0/text",
							v: " wrong",
						},
					],
				},
			}),
		).toBeNull();
		const caption = stream.apply({
			type: "chat_message_delta",
			delta: {
				message_id: "assistant-1",
				v: [
					{
						o: "append",
						p: "/message/content/parts/0/text",
						v: " Explain.",
					},
				],
			},
		});
		expect(caption?.text).toBe("Why this baseline? Explain.");
	});

	it("does not rewind a caption when an older full snapshot arrives", () => {
		const stream = new VoiceCaptionStream();
		stream.apply(
			delta({
				id: "assistant-1",
				author: { role: "assistant" },
				content: {
					parts: [{ text: "答辩现在开始。第一个问题：为什么要去掉递归层" }],
				},
			}),
		);
		const stale = stream.apply(
			delta({
				id: "assistant-1",
				author: { role: "assistant" },
				content: {
					parts: [{ text: "答辩现在开始。第一个问题：为何去掉递归" }],
				},
			}),
		);
		expect(stale?.text).toBe("答辩现在开始。第一个问题：为什么要去掉递归层");
	});

	it("deduplicates a replayed append without suppressing the next distinct chunk", () => {
		const stream = new VoiceCaptionStream();
		stream.apply(
			delta({
				id: "assistant-1",
				author: { role: "assistant" },
				content: { parts: [{ text: "Why" }] },
			}),
		);
		const append = (text: string) =>
			stream.apply({
				type: "chat_message_delta",
				delta: {
					v: [{ o: "append", p: "/message/content/parts/0/text", v: text }],
				},
			});
		append(" this");
		append(" this");
		const caption = append(" method?");
		expect(caption?.text).toBe("Why this method?");
	});

	it("strips undecodable-audio replacement characters from captions", () => {
		const caption = applyVoiceCaptionDelta(
			null,
			delta({
				id: "user-1",
				author: { role: "user" },
				content: { parts: [{ text: "a young asian 好的\uFFFD 解码" }] },
			}),
		);
		expect(caption?.text).toBe("a young asian 好的 解码");
	});

	it("hides a short user ASR fragment echoed from the defense material", () => {
		const echoed = {
			id: "user-echo",
			role: "user" as const,
			text: "need-Paper you pdf而是",
		};
		const material =
			"The need-Paper you pdf而是 section compares the recursive baseline.";
		expect(
			visibleVoiceCaption(echoed, {
				messageIds: new Set(),
				texts: [material],
			}),
		).toBeNull();
	});

	it("injects the scenario persona and planned duration into the bootstrap", () => {
		const bootstrap = buildDefenseBootstrap({
			title: "A paper",
			source: "papers/a/NOTES.md",
			context: "The experiment uses three seeds.",
			language: "zh-CN",
			scenario: "review",
			plannedMinutes: 20,
		});
		expect(bootstrap).toContain("审稿人");
		expect(bootstrap).toContain("约 20 分钟");
		// Duration guidance sits in the recency window, after the material.
		expect(bootstrap.indexOf("答辩材料结束")).toBeLessThan(
			bootstrap.indexOf("约 20 分钟"),
		);
		const untimed = buildDefenseBootstrap({
			title: "A paper",
			source: "papers/a/NOTES.md",
			context: "The experiment uses three seeds.",
			language: "en",
			scenario: "interview",
			plannedMinutes: null,
		});
		expect(untimed).toContain("technical interviewer");
		expect(untimed).not.toContain("Planned length");
		expect(untimed).toContain("Announce the start of the defense exactly once");
		expect(untimed).not.toContain('the single word "Understood"');
		expect(untimed).not.toContain(
			'"Please begin the defense." as a separate message',
		);
		expect(untimed).toContain('Never say "Understood" as an acknowledgment');
		expect(untimed).toContain("The first words you speak must be exactly");
		expect(untimed).toContain("name the section, formula, claim, or example");
		expect(untimed).toContain("Never judge the material's type");
		expect(untimed).toContain('"The defense begins now."');
		expect(untimed).not.toContain("for example:");
		expect(untimed).toContain("no announcing that you entered any mode");
	});

	it("injects language-specific difficulty and live control prompts", () => {
		const advanced = buildDefenseBootstrap({
			title: "A paper",
			source: "papers/a/NOTES.md",
			context: "The experiment uses three seeds.",
			language: "zh-CN",
			difficulty: "advanced",
		});
		expect(advanced).toContain("少问定义复述");
		const basic = buildDefenseBootstrap({
			title: "A paper",
			source: "papers/a/NOTES.md",
			context: "The experiment uses three seeds.",
			language: "en",
			difficulty: "basic",
		});
		expect(basic).toContain("stay at foundational comprehension");
		const adaptive = buildDefenseBootstrap({
			title: "A paper",
			source: "papers/a/NOTES.md",
			context: "The experiment uses three seeds.",
			language: "en",
			difficulty: "adaptive",
		});
		expect(adaptive).not.toContain("Difficulty:");
		expect(buildDefenseContextPatch("See table 2.", "en")).toContain(
			"<context_patch>",
		);
		expect(buildDefenseContextPatch("见表 2。", "zh-CN")).toContain(
			"不是答辩人的回答",
		);
		expect(buildDefenseRefocusPrompt("en")).toContain("Stay on the current");
		expect(buildDefenseRefocusPrompt("zh-CN")).toContain("不要换题");
	});

	it("builds a language-specific bootstrap and local transcript", () => {
		const bootstrap = buildDefenseBootstrap({
			title: "A paper",
			source: "papers/a/NOTES.md",
			context: "The experiment uses three seeds.",
			language: "zh-CN",
		});
		expect(bootstrap).toContain("每一轮只提出一个问题");
		expect(bootstrap).toContain("答辩现在开始");
		expect(bootstrap).toContain("答辩开始只宣布一次");
		expect(bootstrap).not.toContain("只说两个字：“明白”");
		expect(bootstrap).not.toContain("之后我会单独发来“请开始答辩”");
		expect(bootstrap).toContain("不要用“明白”作确认回执");
		expect(bootstrap).toContain(
			"你开口的第一句话必须一字不差是「答辩现在开始。」",
		);
		expect(bootstrap).not.toContain("例如：“答辩现在开始");
		expect(bootstrap).toContain("禁止宣布进入某种模式");
		expect(bootstrap).toContain("不要当作我的回答");
		expect(bootstrap).toContain("点名章节、公式、结论或例题");
		expect(bootstrap).toContain("不要评判这份材料本身");
		expect(bootstrap).toContain("答辩材料开始");
		expect(bootstrap).toContain("答辩材料结束");
		// Recency: the standing rules must come after the (long) material block.
		expect(bootstrap.indexOf("答辩材料结束")).toBeLessThan(
			bootstrap.indexOf("每一轮只提出一个问题"),
		);
		const markdown = buildVoiceTranscriptMarkdown({
			title: "A paper",
			source: "papers/a/NOTES.md",
			context: "The experiment uses three seeds.",
			startedAt: new Date("2026-08-08T08:00:00Z"),
			captions: [{ id: "m1", role: "assistant", text: "Why?" }],
			language: "en",
			durationSeconds: 90,
			materials: ["papers/a"],
			preparationRun: "run-1",
			scenario: "seminar",
		});
		expect(markdown).toContain("kind: voice-defense-transcript");
		expect(markdown).toContain("papers/a");
		expect(markdown).toContain("preparationRun: run-1");
		expect(markdown).toContain("scenario: seminar");
		expect(markdown).toContain("[[papers/a/NOTES.md]]");
		expect(markdown).toContain("Why?");
		expect(voiceTranscriptFileName(new Date(2026, 7, 8, 9, 7, 6))).toBe(
			"20260808-090706.md",
		);
	});

	it("treats acknowledgments as filler and mixed first questions as the opening", () => {
		expect(isOpeningFillerCaption("好的 我已了解背景。")).toBe(true);
		expect(isOpeningFillerCaption("嗯。我")).toBe(true);
		expect(isOpeningFillerCaption("你好，我已经进入审稿模式")).toBe(true);
		expect(isOpeningFillerCaption("Understood.")).toBe(true);
		expect(isDefenseOpeningCaption("好的 我已了解背景。")).toBe(false);
		expect(isDefenseOpeningCaption("定义是什么？")).toBe(true);
		expect(isDefenseAnnouncementCaption("定义是什么？")).toBe(false);
		expect(isOpeningFillerCaption("定义是什么？")).toBe(false);
		expect(
			isDefenseOpeningCaption(
				"好的 我已了解背景。那么,第一个问题,请你说明材料里提到的“作者的创新性”",
			),
		).toBe(true);
		expect(
			isOpeningFillerCaption(
				"好的 我已了解背景。那么,第一个问题,请你说明材料里提到的“作者的创新性”",
			),
		).toBe(false);
		expect(
			visibleAssistantCaptionDuringOpening({
				id: "ack",
				role: "assistant",
				text: "好的 我已了解背景。",
			}),
		).toBeNull();
		// Long meta commentary about the material is still not an opening.
		expect(
			visibleAssistantCaptionDuringOpening({
				id: "meta",
				role: "assistant",
				text: "我看完了这份讲义，内容覆盖二次函数的定义、图像与最值应用。",
			}),
		).toBeNull();
		expect(
			visibleAssistantCaptionDuringOpening({
				id: "q-only",
				role: "assistant",
				text: "机制的设计理由是什么？为什么注意力就足以替代循环和卷积网络？",
			}),
		).toBeNull();
		expect(
			visibleAssistantCaptionDuringOpening({
				id: "q1",
				role: "assistant",
				text: "答辩现在开始。第一个问题：二次函数的顶点公式是什么？",
			}),
		).toMatchObject({ id: "q1" });
		expect(
			visibleAssistantCaptionDuringOpening({
				id: "paraphrase",
				role: "assistant",
				text: "好的，答辩开始。一个问题:你们为什么认为可以完全去掉循环和卷积",
			}),
		).toMatchObject({ id: "paraphrase" });
		expect(
			visibleAssistantCaptionDuringOpening({
				id: "wire-2102",
				role: "assistant",
				text: "答\uFFFD开始。第一个问题: 你认为,用纯注意力替代RNN",
			}),
		).toMatchObject({ id: "wire-2102" });
		expect(
			isAcceptableDefenseOpeningCaption(
				"答\uFFFD开始。第一个问题: 你认为,用纯注意力替代RNN",
			),
		).toBe(true);
		expect(isAcceptableDefenseOpeningCaption("好的，答辩开始")).toBe(true);
		expect(isAcceptableDefenseAnnouncementCaption("好的，答辩开始")).toBe(true);
		expect(isAcceptableDefenseAnnouncementCaption("好,答辩现在开始")).toBe(
			true,
		);
		expect(
			isAcceptableDefenseOpeningCaption(
				"好,答辩现在开始。你在「关键假设」里,你提到的",
			),
		).toBe(true);
		expect(isGrowingDefenseAnnouncementCaption("嗯。答辩")).toBe(true);
		expect(isGrowingDefenseAnnouncementCaption("嗯。答辩现在开始")).toBe(false);
		expect(isGrowingDefenseAnnouncementCaption("你没法保证完全公平")).toBe(
			false,
		);
		expect(isGrowingDefenseAnnouncementCaption("嗯")).toBe(false);
		expect(
			isAcceptableDefenseAnnouncementCaption("第一个问题:你能解释吗？"),
		).toBe(false);
		expect(isAcceptableDefenseOpeningCaption("第一个问题:你能解释吗？")).toBe(
			true,
		);
		expect(
			isAcceptableDefenseOpeningCaption(
				"嗯。答辩现在开始。第一个问题：请解释时间可组合性。",
			),
		).toBe(true);
		expect(
			isAcceptableDefenseOpeningCaption(
				"Um, the defense begins now. First question: why?",
			),
		).toBe(true);
		expect(
			isAcceptableDefenseOpeningCaption(
				"好的,我们来聚焦他们的核心主张。我想问,你在形式化范式层面如何看待它对跨组件依赖的处理。",
			),
		).toBe(false);
		expect(
			isAcceptableDefenseOpeningCaption(
				"机制的设计理由是什么？为什么注意力就足以替代循环和卷积网络？",
			),
		).toBe(false);
		expect(isPureOpeningAckCaption("好的 我已了解背景。")).toBe(true);
		expect(isPureOpeningAckCaption("好的，答辩开始")).toBe(false);
		expect(
			isCanonicalDefenseAnnouncementCaption(
				"答辩现在开始。第一个问题：为什么？",
			),
		).toBe(true);
		expect(
			isCanonicalDefenseAnnouncementCaption(
				"嗯。答辩现在开始。第一个问题：为什么？",
			),
		).toBe(false);
		expect(
			isCanonicalDefenseAnnouncementCaption(
				"嗯答辩现在开始。第一个问题：为什么？",
			),
		).toBe(false);
		expect(
			isCanonicalDefenseAnnouncementCaption(
				"The defense begins now. First question: why?",
			),
		).toBe(true);
		expect(
			isCanonicalDefenseAnnouncementCaption(
				"Um, the defense begins now. First question: why?",
			),
		).toBe(false);
		expect(isCanonicalDefenseAnnouncementCaption("好的，答辩开始")).toBe(false);
		expect(
			isCanonicalDefenseAnnouncementCaption("好的,我们开始答辩。你作为作者"),
		).toBe(false);
		expect(isDefenseOpeningCaption("好的，答辩开始")).toBe(true);
		expect(isOpeningFillerCaption("好的，答辩开始")).toBe(false);
		expect(
			isDefenseOpeningCaption(
				"好的，答辩开始。一个问题:你们为什么认为可以完全去掉循环和卷积",
			),
		).toBe(true);
	});

	it("detects re-announcements of the defense but not ordinary questions", () => {
		// Both observed duplicate openings from real sessions.
		expect(
			isDefenseRestartCaption(
				"嗯。答辩现在开始。第一个问题:论文在第1节为什么认为有必要放弃RNN和CNN",
			),
		).toBe(true);
		expect(
			isDefenseRestartCaption("好的,我们开始答辩。你作为作者,先用两句话概括"),
		).toBe(true);
		expect(
			isDefenseRestartCaption("来看一下。答辩现在开始。第一个问题: 在“定义"),
		).toBe(true);
		expect(
			isDefenseRestartCaption("The defense begins now. First question: why?"),
		).toBe(true);
		expect(
			isDefenseRestartCaption(
				"嗯,答辩现在开始。第一个问题:论文在Introduction里提到要摆脱 RNN 的顺序计算瓶颈。你认为他们替代循环或卷积的动机仅仅是为了并行训练,还是也关乎对长程依赖的建模能力?",
			),
		).toBe(true);
		expect(
			isDefenseRestartCaption("好的，答辩开始。一个问题:你们为什么认为"),
		).toBe(true);
		// Ordinary follow-ups and references must not be treated as restarts.
		expect(
			isDefenseRestartCaption("回到第一个问题，你刚才的回答漏了假设。"),
		).toBe(false);
		expect(isDefenseRestartCaption("我们开始下一个问题。")).toBe(false);
		expect(isDefenseRestartCaption("我们已经开始答辩了，请直接回答。")).toBe(
			false,
		);
		expect(isDefenseRestartCaption("为什么选择自注意力机制？")).toBe(false);
		// Re-asking the first question is a separate detector — it must not
		// widen the announcement matcher, which would catch ordinary follow-ups.
		expect(
			isDefenseRestartCaption(
				"我问第一个问题:论文为什么认为必须去掉循环和卷积,而仅用注意力?如果序列很长呢?用它的自注意力,相较于循环层",
			),
		).toBe(false);
	});

	it("treats filler-only ASR as noise and first-question restatements as reasks", () => {
		expect(isNoiseUserCaption("You So Mmm. Tsk")).toBe(true);
		expect(isNoiseUserCaption("   ")).toBe(true);
		expect(isNoiseUserCaption("...")).toBe(true);
		expect(isNoiseUserCaption("嗯")).toBe(true);
		expect(isNoiseUserCaption("对")).toBe(true);
		expect(isNoiseUserCaption("是")).toBe(true);
		expect(isNoiseUserCaption("What the fuck")).toBe(true);
		expect(isNoiseUserCaption("Huh")).toBe(true);
		expect(isNoiseUserCaption("好")).toBe(true);
		expect(isNoiseUserCaption("因为自注意力可以直接建模任意距离的依赖。")).toBe(
			false,
		);
		expect(isNoiseUserCaption("attention is enough")).toBe(false);
		expect(isSubstantialUserCaption("对")).toBe(false);
		expect(isSubstantialUserCaption("What the fuck")).toBe(false);
		expect(isSubstantialUserCaption("You So Mmm. Tsk")).toBe(false);
		expect(isSubstantialUserCaption("attention is enough")).toBe(true);
		expect(
			isFirstQuestionReaskCaption(
				"我问第一个问题:论文为什么认为必须去掉循环和卷积,而仅用注意力?如果序列很长呢?用它的自注意力,相较于循环层",
			),
		).toBe(true);
		expect(isFirstQuestionReaskCaption("第一个问题:为什么去掉循环?")).toBe(
			true,
		);
		expect(isFirstQuestionReaskCaption("First question: why attention?")).toBe(
			true,
		);
		expect(
			isFirstQuestionReaskCaption("回到第一个问题，你刚才的回答漏了假设。"),
		).toBe(false);
		expect(isFirstQuestionReaskCaption("我们开始下一个问题。")).toBe(false);
	});

	it("retracts a caption when the client emits empty text for that id", () => {
		const first = {
			id: "opening-1",
			role: "assistant" as const,
			text: "好的，答辩开始。一个问题:为什么去掉循环?",
		};
		const duplicate = {
			id: "opening-2",
			role: "assistant" as const,
			text: "嗯",
		};
		const listed = upsertVoiceCaption(upsertVoiceCaption([first], duplicate), {
			...duplicate,
			text: "",
		});
		expect(listed).toEqual([first]);
	});

	it("builds the two-phase opening trigger per language", () => {
		expect(buildDefenseOpeningTrigger("zh-CN")).toContain("答辩现在开始。");
		expect(buildDefenseOpeningTrigger("en")).toContain(
			"The defense begins now.",
		);
	});

	it("keeps the microphone closed until a real first question finishes", () => {
		let opening = createVoiceOpeningState();
		opening = reduceVoiceOpening(opening, {
			type: "voice-state",
			state: "speaking",
		});
		opening = reduceVoiceOpening(opening, {
			type: "assistant-text",
			text: "好的 我已了解背景。",
		});
		expect(opening).toMatchObject({
			phase: "awaiting",
			heardOpening: false,
			voiceState: "speaking",
		});
		opening = reduceVoiceOpening(opening, {
			type: "assistant-text",
			text: "好的，答辩开始。一个问题:为什么去掉循环?",
		});
		expect(opening.phase).toBe("awaiting");
		expect(opening.heardOpening).toBe(true);
		opening = reduceVoiceOpening(opening, { type: "timeout" });
		expect(opening.phase).toBe("awaiting");
		opening = reduceVoiceOpening(opening, {
			type: "voice-state",
			state: "listening",
		});
		expect(opening.phase).toBe("open");
	});

	it("treats a first question with U+FFFD as an acceptable opening", () => {
		let opening = reduceVoiceOpening(createVoiceOpeningState(), {
			type: "voice-state",
			state: "listening",
		});
		opening = reduceVoiceOpening(opening, {
			type: "assistant-text",
			text: "答\uFFFD开始。第一个问题: 你认为,用纯注意力替代RNN",
		});
		expect(opening).toMatchObject({
			phase: "open",
			heardOpening: true,
			voiceState: "listening",
		});
	});

	it("never treats a timeout as proof that the canonical opening was spoken", () => {
		let idle = createVoiceOpeningState();
		idle = reduceVoiceOpening(idle, { type: "timeout" });
		expect(idle).toMatchObject({ phase: "awaiting", heardOpening: false });

		let speaking = reduceVoiceOpening(createVoiceOpeningState(), {
			type: "voice-state",
			state: "speaking",
		});
		speaking = reduceVoiceOpening(speaking, { type: "timeout" });
		expect(speaking.phase).toBe("awaiting");
		expect(speaking.heardOpening).toBe(false);
		speaking = reduceVoiceOpening(speaking, {
			type: "voice-state",
			state: "listening",
		});
		expect(speaking.phase).toBe("awaiting");
	});
});
