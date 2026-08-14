# 语音答辩在 WebKit 报 `Invalid SDP line`

## 现象

ChatGPT 账号已连接，语音会话创建请求也成功返回，但 macOS Agentero 在进入实时通话前报错：

```text
Invalid SDP line.
```

错误发生在前端调用 `RTCPeerConnection.setRemoteDescription()` 解析远端 answer SDP 时。

## 根因

ChatGPT Web Voice 返回的 SDP 可能使用 LF 或混合换行。Host 读取 `answer_sdp` 时直接调用 `.trim()`，会继续保留混合换行，并删除 SDP 末尾的终止换行。Chromium 对这种输入较宽容，macOS WebView 使用的 WebKit SDP 解析器会拒绝它。

## 修复

`voice_session_create` 在将 answer SDP 交给 React 前统一执行：

1. 去除响应外围空白；
2. 将 CRLF、CR 和 LF 统一为 CRLF；
3. 校验每一行符合 SDP 的单字符字段名加 `=` 结构；
4. 重新补上末尾 CRLF；
5. 非 SDP 或包含非法行时返回脱敏的 Host 错误，不再把坏数据交给 WebKit。

## 回归测试

Host 单元测试使用包含前导空行、LF/CRLF 混合换行和缺失末尾换行的 fixture。修复前输出仍为混合换行且没有终止 CRLF；修复后固定得到 WebKit 可解析的规范 SDP。另有测试覆盖非 SDP 响应和非法行。
