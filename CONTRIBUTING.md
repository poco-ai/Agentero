# 参与贡献

报告问题时，请写明操作系统、Agentero 版本和复现步骤，并附上去掉敏感信息的错误提示。较大的功能或架构改动，请先开 Issue 讨论范围。文档、翻译和小修复可以直接提 PR。

- [报告问题](https://github.com/poco-ai/agentero/issues/new?template=bug_report.yml)
- [建议功能](https://github.com/poco-ai/agentero/issues/new?template=feature_request.yml)

开发需要 Node.js 22、仓库指定版本的 pnpm 和 Rust stable。macOS 需要 Xcode Command Line Tools，Windows 需要 WebView2，Linux 需要 WebKitGTK 4.1 和 Tauri 的系统依赖。

```sh
pnpm install
pnpm tauri dev
```

提交前阅读 [AGENTS.md](AGENTS.md)，运行覆盖本次改动的检查，保留仓库的提交钩子。PR 写清触发场景、修改后的行为和验证结果。

提交即表示你同意自己的改动以 [MIT License](LICENSE) 随本项目发布。
