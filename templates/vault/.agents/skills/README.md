# Skills

Create Vault seeds these when missing. Pick with `$` in Composer.

| Skill | Role |
| --- | --- |
| `paper-reader` | 精读 → `{paper}/NOTES.md`，只创建可解析双链 |
| `agentero-cli` | headless `agentero` CLI，含只读双链检查；按平台播种（POSIX `agentero` / Windows `agentero-cli`） |
| `openui-blocks` | 论文阅读/科研只读 UI 块；由 `scripts/generate-openui-catalog.mjs` 生成 |
| `vault-normalizer` | 整理现有研究目录并对比迁移前后的双链诊断 |
| `acdemic-drawing` | 生成学术场景 Excalidraw 图 |
| `idea-evaluator` | 研究 idea 评审 |
| `deep-research` | 综述级文献调研 |
| `research-paper-writing` | 论文写作与审稿前自查 |

## Versioning & upgrades

First-party (and vendored) bundled skills carry an integer frontmatter field:

```yaml
version: 1
```

On vault open, Agentero compares this to the app template:

- **lower version** → auto-upgrade to the template, then toast the skill id
- **same / higher version** → leave the on-disk file alone (including same-version edits)
- **no `version`** → leave alone (user-owned or unversioned install)

To customize a bundled skill and keep your edits across app updates, either
remove `version` or set it higher than the template after editing.

## Third-party source & license

`idea-evaluator` / `deep-research` are vendored from
[HKUSTDial/Supervisor-Skills](https://github.com/HKUSTDial/Supervisor-Skills)
(Yuyu Luo et al.).

**License: [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**  
Full text lives in each vendored skill package's `LICENSE` file.

`paper-reader` / `agentero-cli` / `vault-normalizer` are first-party (Agentero license).
