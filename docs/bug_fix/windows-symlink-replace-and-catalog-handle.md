# Windows 上技能链接、并发写和远程目录删除失败

2026-11-02。`cargo test` 在 Windows 上有三处产品失败：技能目录链接打不开、并发原子替换偶发拒绝访问、远程会话断开删不掉工作目录。

## 根因

- `symlink_dir` 接受带 `/` 的相对目标并立刻返回成功。链接存在，但目标解析不了，junction 回退不会发生。
- `NamedTempFile::persist` 走 `MoveFileExW`。并发替换会短暂返回 access denied（5）、sharing violation（32）或 lock violation（33），一次失败就把整次写入判失败。目标文件没有被截断。
- 远程会话的 catalog 连接留在进程级缓存里。Windows 不能删除已打开的 SQLite 文件，`remove_dir_all(work_root)` 因此失败，调用方还忽略了这个错误。

## 修复

- Windows 建链接前把目标改成 `\`。`symlink_dir` 成功后还要能 `metadata` 读到目标，否则删掉链接再 `mklink /J`。已经存在、目标正好是 `../.agents/skills` 且解析不到的旧链接会删掉重建；用户自己的目录或链接不动。
- 替换改用 `std::fs::rename`。Windows 10 1809+ 上这是 POSIX 语义，并发替换同一个文件不会再因为 `MoveFileExW` 返回拒绝访问而失败。替换失败时删掉临时文件，一直被占用的目标仍然失败，原内容保留。
- 断开会话、确认 sidecar 已经推上去之后，先 `evict_catalog_conn` 再删 `work_root`。推送失败时不删，会话留着重试。
