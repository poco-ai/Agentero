## 摘要

<!-- 一两句话：做了什么，为什么做。关联 issue 请写 Closes #123。 -->

## 类型

- [ ] feat：新功能
- [ ] fix：修复
- [ ] ui：界面
- [ ] refactor
- [ ] docs
- [ ] chore / ci / test

## 场景

<!-- 说明解决了什么问题，修改是否必要，如何与当前功能做结合。功能修改请先关联讨论过的 issue。 -->

## 截图（UI / 功能改动必填）

<!--
在 PR 正文附「之前 / 之后」对比。网页拖入文件，或 gh pr create --attach / gh pr edit --attach。
- 标明「之前」「之后」；全新界面的「之前」可写「无」
- 涉及窄窗口或移动端布局时，再补一张对应尺寸
- 完全没有界面变化：写「无」，不附图片，并且不要勾选 ui 类型
- 截图、GIF、录屏不得提交进仓库，也不要放进 PR diff
-->

## Demo（feat 必填）

<!--
新功能必须在 PR 正文附 10–60 秒短视频或 GIF，上传方式同上。
演示主路径即可：入口 → 关键操作 → 结果。
非 feat 改动可写「不适用」。
-->

## 自查清单

- [ ] 本地 pre-commit 通过（未使用 `--no-verify`）
- [ ] 已运行与改动对应的检查：前端 `pnpm lint` / `pnpm typecheck` / `pnpm test`；Rust `cargo fmt --check` / `cargo clippy` / `cargo test`
- [ ] CI 全绿
- [ ] UI 文案已走 `t()` 并同步 `zh-CN` 翻译（如涉及文案）
- [ ] 相关文档已更新（如涉及已实现功能）
- [ ] 手动验证：
