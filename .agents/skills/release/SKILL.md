---
name: release
description: >-
  Ship an Agentero release: bump the version, commit and push it, create and
  push the release tag, monitor the release workflow, repair real failures,
  rerun capacity failures, and write bilingual release notes to the Draft
  Release. Use when the user asks to bump, tag, push, watch CI, or complete an
  Agentero release. Notes-only and dry-run requests remain available.
---

# Agentero Release

Complete the requested release through a successful Release workflow and written
Draft Release notes. A notes-only or dry-run request does not authorize a version
change, commit, tag, push, workflow rerun, or Release edit.

## Ship the release

When the user names a version and asks to ship it:

1. Follow `.agents/skills/bump/SKILL.md` for the version change and
   `.agents/skills/commit/SKILL.md` for the dedicated
   `chore(release): bump version to <version>` commit. Stop if unrelated work is
   present.
2. Push the release branch, then create and push the annotated tag `v<version>`
   on that version commit. The tag without `v` must match every version field.
3. Never move or overwrite a remote tag that GitHub Actions has already observed
   or that is attached to a Release. If the workflow has not yet observed a
   newly pushed tag, a user-requested correction may replace that tag; otherwise
   stop and report the immutability conflict.
4. Identify the Release workflow run created by the tag. Monitor it through
   completion, including validation, Draft creation, installers, Android, CLI,
   and updater assets.
5. Treat Cloudflare-only failures as non-blocking. Do not rerun or delay the
   release for them.
6. For a failure caused by runner capacity or other transient infrastructure,
   rerun the failed GitHub Actions job. Do not create a new commit or tag.
7. For a real code, configuration, test, or workflow failure, fix it, commit and
   push the correction, then create and push a new release tag for the corrected
   commit. Continue from that run. Do not rewrite the previously observed tag.
8. After the required Release workflow succeeds, verify the expected Draft assets,
   then write the notes below. Leave the Release unpublished.

## Watch workflow progress

Prefer one scheduled check over polling whenever the agent can create a
scheduled task. Poll only when the user explicitly asks for polling.

For a long-running workflow, schedule one check about an hour later. If the run
is still incomplete, report the remaining work and schedule the next one-hour
check. If it failed, apply the failure policy above. If it succeeded, continue
directly to asset verification and release notes.

## Establish the release range

1. Read `git status`, the current branch, local and remote tags, and the target
   Release state. Preserve unrelated working-tree changes.
2. Resolve both endpoints to immutable commits and verify that the base is an
   ancestor of the target.
3. For a stable target, default to the latest earlier published stable Release
   reachable from the target. For a prerelease, prefer the preceding prerelease
   in the same version series, then fall back to the latest stable Release.
4. Display the selected `<base>..<target>` range. Stop for user direction when
   the target, release channel, ancestry, or previous Release is ambiguous.
5. Never move or overwrite an existing remote tag. Treat a tag already observed
   by GitHub Actions or attached to a Release as immutable.

## Collect evidence

Run the bundled collector from the repository root:

```bash
node .agents/skills/release/scripts/collect-release-context.mjs <base> <target>
```

Use merged pull requests as the main narrative units. Always inspect uncovered
first-parent commits as a second source; the presence of one PR does not make
other mainline commits disappear.

For each candidate change:

- Prefer the PR title, body, linked issues, labels, and changed behavior.
- Use the first-parent commit subject, body, and changed files when no merged PR
  covers the commit.
- Inspect the relevant diff or documentation when the public effect is unclear.
- Collect issues closed during the release range that are not already covered by
  a merged PR. Use `gh issue list --state closed --search "closed:>={base-date}"`
  or inspect `Closes` / `Fixes` references in commit messages.
- Exclude release bumps, formatting, tests, internal refactors, and routine
  documentation unless they change installation, compatibility, security, or
  visible behavior.
- Combine multiple commits that implement one user-visible outcome.
- Keep a PR, commit, or issue URL as evidence for every bullet.
- Include the first committer or PR author for each bullet so contributors are
  credited in the notes. **Resolve GitHub usernames** — the git commit author
  name (e.g. `QiyuanChen`) is not necessarily the GitHub handle (e.g.
  `qychen2001`). For PRs, use the PR `author.login` field directly. For
  uncovered commits, run `gh api repos/poco-ai/Agentero/commits/<sha>` and
  extract the `author.login` field. Fall back to the commit `author.name` only
  when the GitHub API returns null (e.g. unauthenticated local commits).
- Report uncertainty or conflicting evidence instead of inventing behavior.

## Draft the notes

Write Chinese first and English second. Mirror the same groups, bullet count,
order, meaning, and evidence links across both languages.

Use this shape:

```markdown
## 概要

<一段简短文字，说明本次发布主题和用户影响。>

## 新功能

- **<关键词或短语>**: <一到两句具体介绍。>（[#123](...) by @author）

## 改进

- **<关键词或短语>**: <一到两句具体介绍。>（[commit](...) by @author）

## 修复

- **<关键词或短语>**: <一到两句具体介绍。>（[#124](...) by @author）

## 已解决问题

- **<关键词或短语>**: <一到两句具体介绍。>（[#125](...) by @author）

---

## Summary

<One short paragraph describing the release theme and user impact.>

## Features

- **<Keyword or short phrase>**: <One or two concrete sentences.> ([#123](...) by @author)

## Improvements

- **<Keyword or short phrase>**: <One or two concrete sentences.> ([commit](...) by @author)

## Fixes

- **<Keyword or short phrase>**: <One or two concrete sentences.> ([#124](...) by @author)

## Resolved Issues

- **<Keyword or short phrase>**: <One or two concrete sentences.> ([#125](...) by @author)
```

Apply these writing rules:

- Start the body exactly at `## 概要`. Do not repeat the Release title,
  version, or date inside the body.
- Do not add `English` or `中文` wrapper headings or language navigation links.
  Separate the Chinese and English sections with a standalone Markdown
  horizontal rule (`---`), then begin English content at `## Summary`.
- Keep `Summary` / `概要` as prose, not a bullet list.
- Start every grouped bullet with `**<keyword or short phrase>**: `. Keep the
  colon and following space outside the bold markers in both languages; never
  write `**<keyword>:**` or `**<关键词>：**`.
- Follow the keyword with one or two specific, user-facing sentences.
- Use `Features / 新功能`, `Improvements / 改进`, `Fixes / 修复`, and
  `Resolved Issues / 已解决问题` when evidence exists. `Resolved Issues` is for
  issues closed during the release that are not already covered by a merged PR.
  Add mirrored groups such as `Security / 安全性`,
  `Breaking Changes / 破坏性变更`, or `Known Limitations / 已知限制` only when
  needed.
- Omit empty groups.
- Describe shipped behavior, not implementation activity or test counts.
- Keep terminology and factual scope equivalent across languages; do not make
  one language a shortened translation of the other.
- End with a compare link when the repository and both refs are available.

## Write the Release notes

After drafting the notes, write them directly to the Draft GitHub Release.

1. Verify the remote tag exists and the Release is a Draft.
2. Verify the required Release workflow completed successfully and expected
   assets exist.
3. Write the body to a temporary file and run:

   ```bash
   gh release edit "<tag>" \
     --repo poco-ai/Agentero \
     --verify-tag \
     --notes-file "<temporary-file>"
   ```

4. Fetch the Release again and confirm the stored body matches.
5. Remove the temporary file.
6. Return the selected range, evidence coverage, and the written body.

Do not publish the Draft. Publishing with
`gh release edit "<tag>" --draft=false` requires explicit approval after the
final body and assets have been reviewed.

## Dry run

When the user explicitly requests a dry run, skip writing to GitHub. Return:

1. The selected range and evidence coverage: PR count, uncovered first-parent
   commit count, and any warnings.
2. The complete bilingual Release note candidate.
3. A statement that no version, commit, tag, push, workflow, or GitHub Release
   was changed.

Do not create a repository note file for a dry run unless requested.
