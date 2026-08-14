# macOS 文件保存反复提示“不完整改名”

## 现象

Vault 文件由 Agent、外部编辑器或原子写入流程保存后，应用反复提示：

> 文件监听器未提供完整的改名前后路径对，因此链接保持不变。

文件内容和工作区刷新通常正常，提示却会在连续保存时重复出现。

## 根因

macOS FSEvents 不保证把一次 rename 的 old/new 两侧关联起来。`notify` 因此可能只产生
`RenameMode::Any` 单边事件；原子保存也可能只暴露最终 Markdown 路径。旧逻辑把所有
`ModifyKind::Name` 都映射为 `kind: "rename"`，即使 payload 没有可信的
`rename.from` / `rename.to`。前端随后把这种系统级歧义当成用户可见警告。

这不是可操作错误，也不能安全用于双链改写。重复 Toast 既无法帮助用户恢复链接，又会
遮挡正常界面。

## 修复

- Host 只有在事件是 `RenameMode::Both`、包含两条不同且未过滤的路径时，才发送
  `kind: "rename"` 和完整 `rename` 对象。
- 单边或被过滤后不完整的 name event 改为 `kind: "other"`，继续触发文件树、Library
  和 Wiki 索引刷新，但不进入链接修复。
- 前端移除不完整 rename 的 Toast 回调，避免将预期的 OS 事件歧义展示为错误。
- 可信 old/new 配对的外部改名修复、安全预览和 dirty-file 门禁保持不变。

## 回归验证

Watcher 单元测试直接构造 macOS 常见的单路径 `RenameMode::Any` Markdown 事件，断言：

- payload 仍会发出，以便结构刷新；
- `kind` 为 `other`；
- `rename` 为空，不会授权链接改写。

