# macOS 新建窗口即崩溃（AppKit 主线程断言）

## 现象

macOS 上按 `⌘N`（File → New Window）打不开新窗口，应用直接消失。日志里只有：

```
[agentero::op] op start window_new
[tauri_runtime_wry] web content process terminated
```

没有 `op end window_new`。崩溃报告（`~/Library/Logs/DiagnosticReports/agentero-*.ips`）的触发线程是 `tokio-rt-worker`：

```
-[NSWMWindowCoordinator performTransactionUsingBlock:]
-[NSWindow(NSWMWindowManagement) window:didUpdateWithChangedProperties:]
-[_WMWindow setExplicitCollectionBehavior:]
-[NSWindow setCollectionBehavior:]
enable_window_tiling
window_new
```

`EXC_BREAKPOINT` / `SIGTRAP`。

## 根因

`enable_window_tiling` 通过 `ns_window()` 拿到底层 `NSWindow` 后直接调用 `setCollectionBehavior:`。该方法必须在其主线程调用：AppKit 会把它转交给窗口管理协调器（`NSWMWindowCoordinator`），非主线程调用会命中断言并终止进程。

`window_new` / `doc_window_open` 是 `async` 命令（见 `window_new` 的注释：Windows 下同步 handler 内建 webview 会死锁），因此整段代码跑在 tokio 工作线程上。窗口本身建得出来，但在 `enable_window_tiling` 处崩溃，所以用户看到的是"按了没反应、应用退出"。

主窗口不受影响，因为它由 `setup` 在主线程创建并加 tiling。

## 修复

`enable_window_tiling` 内部用 `WebviewWindow::run_on_main_thread` 把 `setCollectionBehavior:` 投递回主线程再执行。

## 防再发

在 `async` 命令里操作原生窗口时，任何直接触碰 AppKit 的 `objc2` 调用（`NSWindow` / `NSView` / `NSApplication`）都要先 `run_on_main_thread`；Tauri 自己的 `set_focus` / `set_menu` 已经内部做了线程投递，可以照常直接调用。
