# 无法断开 ChatGPT（Keychain 所有者冲突）

**状态**：已修复  
**日期**：2026-08-15  
**范围**：答辩间「断开」ChatGPT、macOS 系统凭证库

## 现象

状态仍显示「已连接」，点断开后 Toast：

> 无法断开 ChatGPT。  
> could not remove the ChatGPT credential: Invalid attempt to change the owner of this item.

常见于先用 `tauri dev` / debug 二进制登录，再打开打包的 `Agentero.app`。读 token 仍成功，删条目被 Keychain ACL 拒绝（`errSecInvalidOwnerEdit` / `-25240`）。

## 根因

macOS Keychain 把 generic password 绑到创建它的可执行文件。开发二进制与生产 `.app` 路径、签名不同，后者的 `SecItemDelete` / `SecItemUpdate` 会触发所有者编辑错误。原先只把 `errSecItemNotFound` 当成成功，其余一律失败。

## 修复

Host 在 API 删除失败后回退调用系统 `security delete-generic-password`（Apple 签名工具可删用户条目），再用读接口确认条目已不存在。保存凭证遇到同一错误时先走同一删除，再写入。回退仍失败时，前端把该错误换成钥匙串操作说明。

## 验证

- `cargo test -p agentero --lib features::voice::auth`
- `pnpm exec vitest run test/voice-defense-auth-error.test.ts`
- 开发版登录后打开生产包：断开应变为未连接；再连接应能覆盖旧条目
