# 论文导入超时（#161）

**状态**：已修复

## 问题

论文导入中的单个 HTTP 请求虽然已有 timeout，但一次导入可能依次尝试多个 PDF
地址、Crossref/Unpaywall fallback 和 arXiv e-print。请求级 timeout 叠加后，魔棒、
Bib/RIS 导入以及 Zotero Connector 的后台资源任务仍可能长时间没有终态。

## 修复

- `features/paper/import/download.rs` 对一篇论文的整个资源阶段增加 3 分钟截止时间。
- 截止时间覆盖 PDF fallback、Crossref、Unpaywall 和 arXiv e-print。
- 共享资源入口因此同时覆盖魔棒、Bib/RIS、Connector，以及其它调用
  `ensure_paper_assets_*` 的导入路径。
- 超时只记录资源错误，不回滚已写入的 paper 目录、NOTES.md 和 catalog；用户可以
  重新执行补资源。
- Connector 继续先返回 paper 壳，后台任务超时后通过进度事件报告失败。

## 实测依据（2026-08-02）

使用当前实际导入依赖测试了 3 篇 arXiv 论文：

| 阶段 | 实测耗时 |
|---|---:|
| Translator 元数据 | 2.0–2.3 秒 |
| PDF | 2.5–5.3 秒 |
| arXiv e-print | 30.4–54.1 秒 |

其中一篇约 5 MB 的 PDF 在 180 秒内只收到约 4.4 MB，最终触发了现有的单请求
180 秒 timeout。因而整篇资源阶段设置为 3 分钟：覆盖约 54 秒的正常 e-print
峰值，并限制 PDF/fallback 多次尝试的累计等待；单请求仍保留 180 秒上限以适应
较慢但持续有数据的下载。

## 验证

- `cargo fmt --check`
- `cargo test --manifest-path src-tauri/Cargo.toml --lib features::import`
