# 导入第三方 Skill 报「description is too long」（#355）

**状态**：已修复
**影响面**：魔棒导入 GitHub Skill、Composer 本机 Skill 列表的描述展示

## 问题

导入 `https://github.com/Imbad0202/academic-research-skills` 失败：

```text
https://github.com/Imbad0202/academic-research-skills: SKILL.md description is too long
```

该 repo 有 4 个 Skill，只有 `deep-research/SKILL.md` 的 description 超限
（1202 字节 / 986 字符，含中日韩触发词），却导致整个 repo 无法导入。

同时暴露第二个问题：仓库自带的全部 11 个 Skill 都用 YAML 折叠块
（`description: >-`）书写描述，Composer 的 Skill 列表把描述显示成 `>-`。

## 根因

1. `MAX_DESCRIPTION_LEN` 用 `String::len()`（字节）对照社区规范的 1024 **字符**上限，
   CJK 描述会被高估约 3 倍；description 只是候选列表展示用的 metadata，超长不该阻断安装。
2. 候选扫描用 `collect::<Result<Vec<_>, _>>()`，任意一个 `SKILL.md` 解析失败即整仓失败。
   monorepo 常带示例/模板 Skill，这条规则过严。
3. 三处各自手写 frontmatter 解析（`import/skill`、`agent/skills.rs`、
   `vault/mod.rs` 的 `version`），都只取 `description:` 同行文本，遇到 `>-` / `|` 折叠块
   与 CRLF 就失效。
4. 前端 `notifyError(`${input}: …`)` 又拼了一次输入，后端错误已带 `{raw}: ` 前缀，
   于是 toast 里 URL 出现两遍。

## 修复

- 新增共享 `core/frontmatter.rs`：`frontmatter_block()` + `scalar_field()`，支持引号、
  `>` / `|` 折叠块、plain 多行续行、CRLF，并且只读顶层键（不会误取 `metadata.version`）。
  上述三处解析统一改为复用它。
- description 改为按字符截断到 1024（尾部加省略号）而非报错；`SKILL.md` 本体仍原样拷贝。
- 单个 `SKILL.md` 解析失败只跳过该候选；整个来源没有可用 Skill 时才报
  `no importable SKILL.md was found in this source`（并清理暂存包，避免前端弹出空选择框）。
- 前端不再重复拼接输入前缀。

## 回归

- `core::frontmatter::tests`：引号 / 折叠 / 字面块 / CRLF / 嵌套键。
- `import::skill::tests::reads_folded_description`、`truncates_long_description_instead_of_failing`。
- `agent::skills::tests::parses_bundled_folded_description`：直接对模板 `paper-reader/SKILL.md` 断言。
