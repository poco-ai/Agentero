---
name: bump
description: >-
  Upgrade Agentero application, desktop, CLI, and release versions together.
  Use when changing the project version or preparing a release.
---

# Version Bump

升级 Agentero 的应用版本，并确保桌面安装包、CLI 和发布 tag 使用同一个版本号。

## 用法

选择此 Skill 后提供目标版本，例如 `0.1.3` 或 `0.1.3-beta.1`。

## 执行规则

1. 读取当前工作区状态和所有版本来源。不要丢弃或覆盖与版本升级无关的用户改动。
2. 校验目标版本是合法的 SemVer；版本参数缺失或不明确时停止并请求明确版本。
3. 同步修改以下字段：
   - `package.json` 的 `version`。
   - `src-tauri/tauri.conf.json` 的 `version`。
   - `src-tauri/Cargo.toml` 的 package `version`。
   - `crates/agentero-core/Cargo.toml` 的 package `version`（`agentero_core::http` 用 `CARGO_PKG_VERSION` 拼 User-Agent，必须与主 crate 锁步）。
   - `cli/Cargo.toml` 的 package `version`。
   - `crates/agentero-mcp/Cargo.toml` 的 package `version`（MCP `Implementation` 用 `CARGO_PKG_VERSION` 对外报告服务版本，必须与主 crate 锁步）。
   - `src-tauri/ios-project.yml` 的 `CFBundleShortVersionString` 与 `CFBundleVersion`。

   Android 不需要手动修改：`tauri android build` 会从 `tauri.conf.json` 的 `version` 重新生成 `src-tauri/gen/android/app/tauri.properties`（gitignored）中的 `versionName` 与 `versionCode`。
4. 如果 Cargo manifest 版本变化，运行必要的 Cargo 元数据/检查命令并确认 `Cargo.lock` 没有保留旧的本地 package 版本。
5. 检查版本字段全部等于目标版本，并检查 `agentero --version` 的来源仍然是 CLI package version。
6. 核对 `AGENTS.md` 中的发布约束和实际发布流程；规则变化时再更新约束。版本说明和变更日志以实际改动为准。
7. 运行最小必要验证：`cargo metadata --no-deps --format-version 1`，以及适合当前环境的前端类型检查或构建检查。
8. 输出修改文件、验证结果和下一步建议。除非用户明确要求，不创建 commit、tag、Release 或 push。

## 发布前约束

版本 bump 必须先作为独立提交完成，之后才能创建 `v<version>` tag。tag 去掉 `v` 后必须与所有上述版本字段一致。
