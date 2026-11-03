import { describe, expect, it } from "vitest";
import {
	normalizeBranch,
	parseGitHubRemote,
	readWritingGitHub,
	WRITING_GITHUB_KEY,
	type WritingGitHubLink,
	writeWritingGitHub,
} from "@/lib/writing/github";

function memory() {
	const values = new Map<string, string>();
	return {
		getItem: (key: string) => values.get(key) ?? null,
		setItem: (key: string, value: string) => {
			values.set(key, value);
		},
		removeItem: (key: string) => {
			values.delete(key);
		},
	};
}

const PAPER_A: WritingGitHubLink = {
	remote: "https://github.com/ada/paper-a.git",
	branch: "main",
	label: "ada/paper-a",
};

const PAPER_B: WritingGitHubLink = {
	remote: "https://github.com/ada/paper-b.git",
	branch: "main",
	label: "ada/paper-b",
};

describe("writing github link", () => {
	it("accepts a GitHub repository and rejects anything else", () => {
		expect(parseGitHubRemote("https://github.com/ada/writing")).toEqual({
			remote: "https://github.com/ada/writing.git",
			label: "ada/writing",
		});
		expect(parseGitHubRemote("git@github.com:ada/writing.git")).toEqual({
			remote: "https://github.com/ada/writing.git",
			label: "ada/writing",
		});
		expect(parseGitHubRemote("https://gitlab.com/ada/writing")).toBeNull();
		expect(
			parseGitHubRemote("https://github.com/ada/writing/extra"),
		).toBeNull();
		expect(normalizeBranch("main")).toBe("main");
		expect(normalizeBranch("../main")).toBeNull();
	});

	it("keeps one repository per project", () => {
		const storage = memory();
		writeWritingGitHub("D:/vault", "thesis/paper-a", PAPER_A, storage);
		writeWritingGitHub("D:/vault", "thesis/paper-b", PAPER_B, storage);
		expect(readWritingGitHub("D:/vault", "thesis/paper-a", storage)).toEqual(
			PAPER_A,
		);
		expect(readWritingGitHub("D:/vault", "thesis/paper-b", storage)).toEqual(
			PAPER_B,
		);
		expect(readWritingGitHub("D:/vault", "thesis/paper-c", storage)).toBeNull();
		expect(readWritingGitHub("D:/other", "thesis/paper-a", storage)).toBeNull();
	});

	it("reads the shelf repository written by older builds", () => {
		const storage = memory();
		storage.setItem(
			WRITING_GITHUB_KEY,
			JSON.stringify({
				"D:/vault": {
					remote: "https://github.com/ada/writing",
					branch: "main",
				},
			}),
		);
		expect(readWritingGitHub("D:/vault", "thesis", storage)).toEqual({
			remote: "https://github.com/ada/writing.git",
			branch: "main",
			label: "ada/writing",
		});
		expect(readWritingGitHub("D:/vault", "thesis/paper-a", storage)).toBeNull();
	});
});
