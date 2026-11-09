import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	deleteHistorySession,
	hydrateSessionTitles,
	isSessionIdPrefixTitle,
	mergeImportedSessions,
	renameHistorySessionTitle,
	sanitizeChatLines,
	sessionsNeedingTitleHydration,
	titleFromLoadedHistory,
} from "@/components/agent/hooks/use-agent-history";
import * as agentApi from "@/lib/agent";
import {
	type AgentSessionRecord,
	agentSessionStore,
} from "@/lib/agent/agent-session-store";
import type { AcpSessionInfo } from "@/lib/agent/api";
import { encodeMentionToken } from "@/lib/agent/composer-inline-tokens";
import * as titleCache from "@/lib/agent/history-title-cache";
import {
	isDismissedAcpSession,
	rememberDismissedAcpSession,
	rememberEmptyAcpSession,
} from "@/lib/agent/history-title-cache";

vi.mock("@/lib/agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@/lib/agent")>();
	return {
		...actual,
		loadSession: vi.fn(),
		deleteSession: vi.fn(),
		cancelAgentRun: vi.fn(),
	};
});

function makeRecord(
	opts: Partial<AgentSessionRecord> & { id: string },
): AgentSessionRecord {
	return {
		id: opts.id,
		agentId: opts.agentId ?? "agent-1",
		source: opts.source ?? "external",
		title: opts.title ?? "",
		agentName: opts.agentName ?? "Agent",
		startedAt: opts.startedAt ?? "2026/8/21 19:11:00",
		lines: opts.lines ?? [],
		status: opts.status ?? "completed",
		providerSessionId: opts.providerSessionId ?? null,
		...opts,
	};
}

function makeAcpSession(
	opts: Partial<AcpSessionInfo> & { sessionId: string },
): AcpSessionInfo {
	return {
		sessionId: opts.sessionId,
		cwd: opts.cwd ?? "/vault",
		title: opts.title ?? null,
		updatedAt: opts.updatedAt ?? "2026-08-21T19:11:00Z",
		...opts,
	};
}

describe("sanitizeChatLines", () => {
	it("preserves visualAnnotations and images on user turns", () => {
		const lines = [
			{
				id: "l1",
				kind: "user" as const,
				text: "explain",
				visualAnnotations: [
					{
						id: "v1",
						page: 1,
						comment: "region",
						image: { data: "base64", mimeType: "image/png" },
					},
				],
				images: [{ data: "base64", mimeType: "image/png" }],
			},
		];
		const out = sanitizeChatLines(lines);
		expect(out).toHaveLength(1);
		expect(out[0]?.visualAnnotations).toHaveLength(1);
		expect(out[0]?.visualAnnotations?.[0]?.id).toBe("v1");
		expect(out[0]?.images).toHaveLength(1);
	});

	it("keeps a chip-only user turn and its markup", () => {
		const lines = [
			{
				id: "l1",
				kind: "user" as const,
				text: "",
				markup: encodeMentionToken("notes/论文关系图.md"),
			},
		];
		const out = sanitizeChatLines(lines);
		expect(out).toHaveLength(1);
		expect(out[0]?.kind === "user" && out[0].markup).toContain("{{m:");
	});

	it("drops empty user turns that have no text, visuals, or images", () => {
		const lines = [
			{
				id: "l1",
				kind: "user" as const,
				text: "   ",
			},
		];
		expect(sanitizeChatLines(lines)).toHaveLength(0);
	});

	it("keeps user turns that are visual-only", () => {
		const lines = [
			{
				id: "l1",
				kind: "user" as const,
				text: "",
				visualAnnotations: [
					{
						id: "v1",
						page: 1,
						comment: "region",
						image: { data: "base64", mimeType: "image/png" },
					},
				],
			},
		];
		expect(sanitizeChatLines(lines)).toHaveLength(1);
	});
});

describe("isSessionIdPrefixTitle", () => {
	it("matches the historical 8-char slice and leading Kimi-style leftovers", () => {
		expect(isSessionIdPrefixTitle("ses_3a2a", "ses_3a2abcdef")).toBe(true);
		expect(isSessionIdPrefixTitle("ses_3a2", "ses_3a2abcdef")).toBe(true);
		expect(isSessionIdPrefixTitle("ses_3a2abcdef", "ses_3a2abcdef")).toBe(true);
		expect(
			isSessionIdPrefixTitle("Summarize this paper", "ses_3a2abcdef"),
		).toBe(false);
	});
});

describe("titleFromLoadedHistory", () => {
	it("uses the first user turn when present", () => {
		const history = {
			sessionId: "s1",
			lines: [
				{ id: "l1", kind: "agent" as const, text: "hello" },
				{ id: "l2", kind: "user" as const, text: "summarize this paper" },
			],
		};
		expect(titleFromLoadedHistory(history)).toBe("summarize this paper");
	});

	it("falls back to the ACP-provided title when there is no user turn", () => {
		const history = {
			sessionId: "s1",
			title: "ACP title",
			lines: [{ id: "l1", kind: "agent" as const, text: "hello" }],
		};
		expect(titleFromLoadedHistory(history)).toBe("ACP title");
	});

	it("returns empty string when neither user turn nor ACP title exists", () => {
		const history = {
			sessionId: "s1",
			lines: [{ id: "l1", kind: "agent" as const, text: "hello" }],
		};
		expect(titleFromLoadedHistory(history)).toBe("");
	});
});

describe("mergeImportedSessions", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("omits sessions already known to have no transcript", () => {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => {
				storage.set(key, value);
			},
			removeItem: (key: string) => {
				storage.delete(key);
			},
		});
		rememberEmptyAcpSession("agent-1", "s1");

		const { sessions } = mergeImportedSessions(
			[],
			[makeAcpSession({ sessionId: "s1", title: "New chat" })],
			"agent-1",
			"Agent",
			"zh-CN",
		);

		expect(sessions).toHaveLength(0);
	});

	it("omits sessions the user deleted, including a local running row", () => {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => {
				storage.set(key, value);
			},
			removeItem: (key: string) => {
				storage.delete(key);
			},
		});
		rememberDismissedAcpSession("agent-1", "prov");

		const { sessions } = mergeImportedSessions(
			[
				makeRecord({
					id: "runtime",
					providerSessionId: "prov",
					source: "local",
					status: "running",
					lines: [{ id: "u1", kind: "user" as const, text: "hello" }],
				}),
			],
			[makeAcpSession({ sessionId: "prov", title: "Kept" })],
			"agent-1",
			"Agent",
			"zh-CN",
		);

		expect(sessions).toHaveLength(0);
		expect(isDismissedAcpSession("agent-1", "prov")).toBe(true);
	});

	it("flags untitled external sessions as hydration candidates", () => {
		const prev: AgentSessionRecord[] = [];
		const chatSessions = [makeAcpSession({ sessionId: "s1", title: null })];

		const { sessions, hydrationCandidates } = mergeImportedSessions(
			prev,
			chatSessions,
			"agent-1",
			"Agent",
			"zh-CN",
		);

		expect(sessions).toHaveLength(1);
		// Empty until hydration / open — never seed with the session-id prefix (#484).
		expect(sessions[0].title).toBe("");
		expect(hydrationCandidates).toHaveLength(1);
		expect(hydrationCandidates[0].id).toBe("s1");
	});

	it("does not flag titled external sessions", () => {
		const prev: AgentSessionRecord[] = [];
		const chatSessions = [
			makeAcpSession({ sessionId: "s1", title: "Already named" }),
		];

		const { sessions, hydrationCandidates } = mergeImportedSessions(
			prev,
			chatSessions,
			"agent-1",
			"Agent",
			"zh-CN",
		);

		expect(sessions[0].title).toBe("Already named");
		expect(hydrationCandidates).toHaveLength(0);
	});

	it("derives title from first local user turn when ACP title is empty", () => {
		const prev = [
			makeRecord({
				id: "s1",
				source: "local",
				title: "Local title",
				lines: [
					{
						id: "l1",
						kind: "user" as const,
						text: "local question",
					},
				],
				providerSessionId: "s1",
			}),
		];
		const chatSessions = [makeAcpSession({ sessionId: "s1", title: null })];

		const { sessions, hydrationCandidates } = mergeImportedSessions(
			prev,
			chatSessions,
			"agent-1",
			"Agent",
			"zh-CN",
		);

		expect(sessions[0].title).toBe("local question");
		expect(hydrationCandidates).toHaveLength(0);
	});

	it("drops session-id placeholder titles and flags for hydration", () => {
		const prev = [
			makeRecord({
				id: "s1abcdef",
				source: "local",
				title: "s1abcdef".slice(0, 8),
				lines: [],
				providerSessionId: "s1abcdef",
			}),
		];
		const chatSessions = [
			makeAcpSession({ sessionId: "s1abcdef", title: null }),
		];

		const { sessions, hydrationCandidates } = mergeImportedSessions(
			prev,
			chatSessions,
			"agent-1",
			"Agent",
			"zh-CN",
		);

		expect(sessions[0].title).toBe("");
		expect(hydrationCandidates).toHaveLength(1);
		expect(hydrationCandidates[0].id).toBe("s1abcdef");
	});

	it("keeps a prior human title when there are no lines and ACP title is empty", () => {
		const prev = [
			makeRecord({
				id: "s1",
				source: "external",
				title: "Earlier hydrated title",
				lines: [],
				providerSessionId: "s1",
			}),
		];
		const chatSessions = [makeAcpSession({ sessionId: "s1", title: null })];

		const { sessions, hydrationCandidates } = mergeImportedSessions(
			prev,
			chatSessions,
			"agent-1",
			"Agent",
			"zh-CN",
		);

		expect(sessions[0].title).toBe("Earlier hydrated title");
		expect(hydrationCandidates).toHaveLength(0);
	});

	it("keeps a user-renamed title over a newer ACP title (#710)", () => {
		vi.spyOn(titleCache, "getOverriddenHistoryTitle").mockReturnValue(
			"My rename",
		);
		const prev = [
			makeRecord({
				id: "s1",
				source: "external",
				title: "My rename",
				titleLocked: true,
				lines: [],
				providerSessionId: "s1",
			}),
		];
		const chatSessions = [
			makeAcpSession({ sessionId: "s1", title: "ACP pushed title" }),
		];

		const { sessions, hydrationCandidates } = mergeImportedSessions(
			prev,
			chatSessions,
			"agent-1",
			"Agent",
			"zh-CN",
		);

		expect(sessions[0].title).toBe("My rename");
		expect(sessions[0].titleLocked).toBe(true);
		expect(hydrationCandidates).toHaveLength(0);
		vi.mocked(titleCache.getOverriddenHistoryTitle).mockRestore();
	});
});

describe("sessionsNeedingTitleHydration", () => {
	it("includes empty and id-prefix titles, skips derived local lines", () => {
		const sessions = [
			makeRecord({ id: "a", title: "" }),
			makeRecord({
				id: "ses_abcdxxxx",
				title: "ses_abcd",
				providerSessionId: "ses_abcdxxxx",
			}),
			makeRecord({
				id: "c",
				title: "",
				lines: [{ id: "l1", kind: "user" as const, text: "hello" }],
			}),
			makeRecord({ id: "d", title: "Real title" }),
			makeRecord({ id: "e", title: "", titleLocked: true }),
		];
		const need = sessionsNeedingTitleHydration(sessions, "agent-1");
		expect(need.map((s) => s.id)).toEqual(["a", "ses_abcdxxxx"]);
	});
});

describe("renameHistorySessionTitle", () => {
	it("locks the title in the session store and writes an override (#710)", () => {
		const setUser = vi
			.spyOn(titleCache, "setUserHistoryTitle")
			.mockImplementation(() => {});
		const item = makeRecord({
			id: "s1",
			title: "Old",
			providerSessionId: "prov-1",
		});
		agentSessionStore.setState({ sessions: [item], activeTabId: "s1" });

		expect(renameHistorySessionTitle(item, "  New title  ")).toBe("New title");
		expect(setUser).toHaveBeenCalledWith(
			"agent-1",
			"s1",
			"New title",
			"prov-1",
		);
		const updated = agentSessionStore
			.getState()
			.sessions.find((session) => session.id === "s1");
		expect(updated?.title).toBe("New title");
		expect(updated?.titleLocked).toBe(true);
		setUser.mockRestore();
	});
});

describe("hydrateSessionTitles", () => {
	beforeEach(() => {
		vi.resetAllMocks();
		vi.spyOn(titleCache, "getCachedHistoryTitle").mockReturnValue(null);
		vi.spyOn(titleCache, "setCachedHistoryTitle").mockImplementation(() => {});
	});

	it("loads untitled sessions and updates their titles", async () => {
		const mockedLoadSession = vi.mocked(agentApi.loadSession);
		mockedLoadSession.mockResolvedValue({
			sessionId: "s1",
			lines: [
				{ id: "l1", kind: "user" as const, text: "what is the main claim?" },
			],
		});

		const setSessionHistory = vi.fn();
		const historyGenRef = { current: 1 };
		const items = [makeRecord({ id: "s1", providerSessionId: "s1" })];

		await hydrateSessionTitles(items, {
			generation: 1,
			historyGenRef,
			selectedAgentId: "agent-1",
			vaultPath: "/vault",
			setSessionHistory,
		});

		expect(mockedLoadSession).toHaveBeenCalledWith({
			agentId: "agent-1",
			sessionId: "s1",
			vaultPath: "/vault",
		});

		expect(setSessionHistory).toHaveBeenCalledTimes(1);
		const updater = setSessionHistory.mock.calls[0][0] as (
			prev: AgentSessionRecord[],
		) => AgentSessionRecord[];
		const next = updater(items);
		expect(next[0].title).toBe("what is the main claim?");
		expect(titleCache.setCachedHistoryTitle).toHaveBeenCalledWith(
			"agent-1",
			"s1",
			"what is the main claim?",
		);
	});

	it("uses the title cache and skips session/load", async () => {
		vi.mocked(titleCache.getCachedHistoryTitle).mockReturnValue("cached title");
		const mockedLoadSession = vi.mocked(agentApi.loadSession);
		const setSessionHistory = vi.fn();
		const historyGenRef = { current: 1 };
		const items = [makeRecord({ id: "s1", providerSessionId: "s1" })];

		await hydrateSessionTitles(items, {
			generation: 1,
			historyGenRef,
			selectedAgentId: "agent-1",
			vaultPath: "/vault",
			setSessionHistory,
		});

		expect(mockedLoadSession).not.toHaveBeenCalled();
		const updater = setSessionHistory.mock.calls[0][0] as (
			prev: AgentSessionRecord[],
		) => AgentSessionRecord[];
		expect(updater(items)[0].title).toBe("cached title");
	});

	it("does nothing when generation changes", async () => {
		const mockedLoadSession = vi.mocked(agentApi.loadSession);
		const setSessionHistory = vi.fn();
		const historyGenRef = { current: 2 };

		await hydrateSessionTitles([makeRecord({ id: "s1" })], {
			generation: 1,
			historyGenRef,
			selectedAgentId: "agent-1",
			vaultPath: null,
			setSessionHistory,
		});

		expect(mockedLoadSession).not.toHaveBeenCalled();
		expect(setSessionHistory).not.toHaveBeenCalled();
	});

	it("drops a loaded session that has no transcript", async () => {
		const mockedLoadSession = vi.mocked(agentApi.loadSession);
		mockedLoadSession.mockResolvedValue({
			sessionId: "s1",
			title: "New chat",
			lines: [],
		});
		vi.spyOn(titleCache, "rememberEmptyAcpSession").mockImplementation(
			() => {},
		);

		const setSessionHistory = vi.fn();
		const historyGenRef = { current: 1 };
		const items = [makeRecord({ id: "s1", providerSessionId: "s1" })];

		await hydrateSessionTitles(items, {
			generation: 1,
			historyGenRef,
			selectedAgentId: "agent-1",
			vaultPath: "/vault",
			setSessionHistory,
		});

		expect(titleCache.rememberEmptyAcpSession).toHaveBeenCalledWith(
			"agent-1",
			"s1",
		);
		const updater = setSessionHistory.mock.calls[0][0] as (
			prev: AgentSessionRecord[],
		) => AgentSessionRecord[];
		expect(updater(items)).toEqual([]);
	});

	it("ignores failed loads silently", async () => {
		const mockedLoadSession = vi.mocked(agentApi.loadSession);
		mockedLoadSession.mockRejectedValue(new Error("network"));

		const setSessionHistory = vi.fn();
		const historyGenRef = { current: 1 };

		await hydrateSessionTitles([makeRecord({ id: "s1" })], {
			generation: 1,
			historyGenRef,
			selectedAgentId: "agent-1",
			vaultPath: null,
			setSessionHistory,
		});

		expect(mockedLoadSession).toHaveBeenCalledTimes(1);
		expect(setSessionHistory).not.toHaveBeenCalled();
	});
});

describe("deleteHistorySession", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		agentSessionStore.getState().setSessions([]);
		agentSessionStore.getState().startDraft();
	});

	function stubStorage() {
		const storage = new Map<string, string>();
		vi.stubGlobal("localStorage", {
			getItem: (key: string) => storage.get(key) ?? null,
			setItem: (key: string, value: string) => {
				storage.set(key, value);
			},
			removeItem: (key: string) => {
				storage.delete(key);
			},
		});
	}

	it("cancels a running turn, hides the provider id, and leaves the open draft", async () => {
		stubStorage();
		vi.mocked(agentApi.cancelAgentRun).mockResolvedValue(undefined);
		vi.mocked(agentApi.deleteSession).mockResolvedValue({
			sessionId: "prov",
			deletedOnAgent: false,
			agentError: null,
		});
		agentSessionStore.getState().setSessions([
			makeRecord({
				id: "runtime",
				providerSessionId: "prov",
				status: "running",
			}),
		]);
		agentSessionStore.getState().setActiveTabId("runtime");

		const result = await deleteHistorySession(
			makeRecord({
				id: "runtime",
				providerSessionId: "prov",
				status: "running",
			}),
			"/vault",
		);

		expect(agentApi.cancelAgentRun).toHaveBeenCalledWith("runtime");
		expect(agentApi.deleteSession).toHaveBeenCalledWith({
			agentId: "agent-1",
			sessionId: "prov",
			vaultPath: "/vault",
		});
		expect(result.deletedOnAgent).toBe(false);
		expect(agentSessionStore.getState().sessions).toEqual([]);
		expect(agentSessionStore.getState().activeTabId).toBe("draft");
		expect(isDismissedAcpSession("agent-1", "prov")).toBe(true);
		expect(isDismissedAcpSession("agent-1", "runtime")).toBe(true);
	});
});
