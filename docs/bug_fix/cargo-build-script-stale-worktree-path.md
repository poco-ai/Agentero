# Cargo 构建脚本读取了旧 worktree 路径

## 现象

切回主 checkout 后启动桌面应用，`agentero-core` 的构建脚本报
`read onboarding notes directory: No such file or directory`，
`cargo:rerun-if-changed` 指向已删除 worktree 中的 `templates/vault/notes`。

## 原因与修复

`build.rs` 中的 `env!("CARGO_MANIFEST_DIR")` 在编译构建脚本时就固化了路径。
复用其他 checkout 的构建脚本产物后，脚本仍使用原 checkout 的目录。

构建脚本改用 `std::env::var_os("CARGO_MANIFEST_DIR")`，读取 Cargo 在本次
执行脚本时提供的目录。`agentero-core` 的 onboarding 和 Skill 模板生成，
以及桌面 Host 的根目录 `.env` 读取都遵循此规则。应用源码中有意在编译时
嵌入资源的 `env!` 用法保持原有语义。

## 回归验证

编译 `crates/agentero-core/build.rs` 时把 `CARGO_MANIFEST_DIR` 指向不存在的
旧 checkout；执行同一脚本二进制时，将它设为当前 crate 目录，并提供临时
`OUT_DIR`。脚本应成功生成两份模板表，依赖路径与 `include_str!` 路径均来自
当前 checkout。随后运行 `pnpm tauri dev`，确认桌面主窗口完成加载。
