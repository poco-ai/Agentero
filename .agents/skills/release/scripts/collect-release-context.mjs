#!/usr/bin/env node

import { execFileSync } from "node:child_process";

const MAX_FIRST_PARENT_COMMITS = 500;

function fail(message) {
	process.stderr.write(`release-context: ${message}\n`);
	process.exit(1);
}

function run(command, args, options = {}) {
	try {
		return execFileSync(command, args, {
			cwd: process.cwd(),
			encoding: "utf8",
			maxBuffer: 32 * 1024 * 1024,
			stdio: ["ignore", "pipe", options.quietStderr ? "ignore" : "pipe"],
		}).trim();
	} catch (error) {
		if (options.allowFailure) {
			return null;
		}

		const stderr = error.stderr?.toString().trim();
		fail(stderr || `${command} ${args.join(" ")} failed`);
	}
}

function resolveCommit(ref) {
	return run("git", ["rev-parse", "--verify", `${ref}^{commit}`]);
}

function repositoryFromRemote() {
	const remote = run("git", ["remote", "get-url", "origin"], {
		allowFailure: true,
		quietStderr: true,
	});
	if (!remote) {
		return null;
	}

	const match = remote.match(
		/(?:github\.com[:/])([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
	);
	return match ? `${match[1]}/${match[2]}` : null;
}

function resolveRepository(warnings) {
	if (process.env.GITHUB_REPOSITORY) {
		return process.env.GITHUB_REPOSITORY;
	}

	const fromGh = run(
		"gh",
		["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
		{ allowFailure: true, quietStderr: true },
	);
	if (fromGh) {
		return fromGh;
	}

	const fromRemote = repositoryFromRemote();
	if (!fromRemote) {
		warnings.push(
			"Could not resolve the GitHub repository; PR metadata and web links are unavailable.",
		);
	}
	return fromRemote;
}

function parseFirstParentCommits(baseRef, targetRef, repository) {
	const raw = run("git", [
		"log",
		"--first-parent",
		"--date=short",
		"--format=%H%x1f%h%x1f%cs%x1f%an%x1f%s%x1f%b%x1e",
		`${baseRef}..${targetRef}`,
	]);

	if (!raw) {
		return [];
	}

	return raw
		.split("\x1e")
		.map((record) => record.replace(/^\n+/, "").trimEnd())
		.filter(Boolean)
		.map((record) => {
			const [sha, shortSha, date, author, subject, ...bodyParts] =
				record.split("\x1f");
			const files = run(
				"git",
				["diff-tree", "--no-commit-id", "--name-only", "-r", sha],
				{ allowFailure: true, quietStderr: true },
			);
			return {
				sha,
				shortSha,
				date,
				author,
				subject,
				body: bodyParts.join("\x1f").trim(),
				files: files ? files.split("\n").filter(Boolean) : [],
				url: repository
					? `https://github.com/${repository}/commit/${sha}`
					: null,
			};
		});
}

function fetchAssociatedPullRequests(repository, sha, warnings) {
	if (!repository) {
		return [];
	}

	const raw = run(
		"gh",
		[
			"api",
			"-H",
			"Accept: application/vnd.github+json",
			`repos/${repository}/commits/${sha}/pulls`,
		],
		{ allowFailure: true, quietStderr: true },
	);
	if (raw === null) {
		warnings.push(
			`Could not fetch PR associations for ${sha.slice(0, 7)}; treat it as an uncovered commit until verified.`,
		);
		return [];
	}

	try {
		return JSON.parse(raw).filter((pullRequest) => pullRequest.merged_at);
	} catch {
		warnings.push(
			`GitHub returned invalid PR metadata for ${sha.slice(0, 7)}; treat it as an uncovered commit until verified.`,
		);
		return [];
	}
}

function pullRequestSummary(pullRequest, coveredCommit) {
	return {
		number: pullRequest.number,
		title: pullRequest.title,
		body: pullRequest.body ?? "",
		url: pullRequest.html_url,
		author: pullRequest.user?.login ?? null,
		createdAt: pullRequest.created_at,
		mergedAt: pullRequest.merged_at,
		mergeCommitSha: pullRequest.merge_commit_sha,
		baseRefName: pullRequest.base?.ref ?? null,
		headRefName: pullRequest.head?.ref ?? null,
		labels: (pullRequest.labels ?? []).map((label) => label.name),
		coveredFirstParentCommits: [coveredCommit.sha],
	};
}

function main() {
	const [baseRef, targetRef, ...extra] = process.argv.slice(2);
	if (!baseRef || !targetRef || extra.length > 0) {
		fail("usage: node collect-release-context.mjs <base-ref> <target-ref>");
	}

	run("git", ["rev-parse", "--show-toplevel"]);
	const baseSha = resolveCommit(baseRef);
	const targetSha = resolveCommit(targetRef);
	const ancestral = run(
		"git",
		["merge-base", "--is-ancestor", baseSha, targetSha],
		{ allowFailure: true, quietStderr: true },
	);
	if (ancestral === null) {
		fail(`${baseRef} is not an ancestor of ${targetRef}`);
	}
	if (baseSha === targetSha) {
		fail("base and target resolve to the same commit");
	}

	const warnings = [];
	const repository = resolveRepository(warnings);
	const commits = parseFirstParentCommits(baseSha, targetSha, repository);
	if (commits.length === 0) {
		fail(`no first-parent commits found in ${baseRef}..${targetRef}`);
	}
	if (commits.length > MAX_FIRST_PARENT_COMMITS) {
		fail(
			`range contains ${commits.length} first-parent commits; narrow it below ${MAX_FIRST_PARENT_COMMITS + 1}`,
		);
	}

	const pullRequests = new Map();
	const coveredCommitShas = new Set();
	for (const commit of commits) {
		const associated = fetchAssociatedPullRequests(
			repository,
			commit.sha,
			warnings,
		);
		for (const pullRequest of associated) {
			coveredCommitShas.add(commit.sha);
			const existing = pullRequests.get(pullRequest.number);
			if (existing) {
				existing.coveredFirstParentCommits.push(commit.sha);
			} else {
				pullRequests.set(
					pullRequest.number,
					pullRequestSummary(pullRequest, commit),
				);
			}
		}
	}

	const uncoveredCommits = commits.filter(
		(commit) => !coveredCommitShas.has(commit.sha),
	);
	const compareUrl = repository
		? `https://github.com/${repository}/compare/${encodeURIComponent(baseRef)}...${encodeURIComponent(targetRef)}`
		: null;

	process.stdout.write(
		`${JSON.stringify(
			{
				schemaVersion: 1,
				repository,
				range: {
					base: { ref: baseRef, sha: baseSha },
					target: { ref: targetRef, sha: targetSha },
					compareUrl,
				},
				coverage: {
					firstParentCommitCount: commits.length,
					mergedPullRequestCount: pullRequests.size,
					uncoveredFirstParentCommitCount: uncoveredCommits.length,
				},
				pullRequests: [...pullRequests.values()],
				uncoveredCommits,
				firstParentCommits: commits.map((commit) => ({
					...commit,
					coveredByPullRequests: [...pullRequests.values()]
						.filter((pullRequest) =>
							pullRequest.coveredFirstParentCommits.includes(commit.sha),
						)
						.map((pullRequest) => pullRequest.number),
				})),
				warnings: [...new Set(warnings)],
			},
			null,
			2,
		)}\n`,
	);
}

main();
