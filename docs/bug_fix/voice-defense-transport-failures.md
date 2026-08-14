# 语音答辩传输故障回收

## 现象

麦克风权限拒绝时只显示浏览器原始错误；WebRTC 短暂断开、持续断网或 DataChannel 关闭时，答辩弹窗可能停留在通话状态，媒体轨道与内部 Sidecar 的释放时机不明确。

## 原因

Voice 客户端只处理了 WebRTC `failed`，没有覆盖 `disconnected`、浏览器离线事件及通话建立后的 DataChannel 错误。`getUserMedia` 异常也没有稳定错误码，界面无法通过 i18n 提供可操作提示。

## 修复

- 将麦克风拒绝、缺失、占用和不可用映射为稳定错误码；
- WebRTC `disconnected` 保留五秒恢复窗口，恢复后取消终止计时；
- 持续断网、WebRTC `failed`、DataChannel 关闭或失败统一进入终止路径；
- 终止路径立即停止本地与远端媒体，并尽力释放会话；Sidecar 已崩溃时释放仍按幂等成功处理；
- 已收到的字幕保留在弹窗中，关闭时仍可保存到 Vault；
- 所有面向用户的故障提示通过 `react-i18next` 提供中英文文案。

## 回归

- 单元测试覆盖浏览器麦克风异常与 WebRTC 状态到错误码的映射；
- 前端全量测试和 TypeScript 类型检查通过；
- Rust Voice 命令、Sidecar 和 Clippy 检查通过。
