# Agent Note：目录守卫按文件系统后端解析出的目标分类

状态：已实现

[English](2026-11-13-directory-guard-resolves-through-fs.md) | 中文

## 问题

[guard.ts](../../../../plugins/dsh-directory-guard/src/guard.ts) 按自己对工具调用目标的理解做判断。工具识别是固定名单（`read`、`write`、`edit`、`str_replace_editor`、`grep`、`glob`），因此 `read_image`、`lsp` 与 `present` 经 `next()` 放行，可读取所有授权之外的文件。路径规范化先执行 `path.resolve()` 再取 `realpath`，会把 `proj/link/../secret` 按字面折叠成 `proj/secret`；而 [fs-local](../../../../packages/fs/fs-local/src/fsio.ts) 保留 `..`，在跟随 `link` 之后按物理路径解析。于是守卫判定的路径在授权内，后端实际打开的路径却在授权外。相对路径还使用了会话头的 cwd，而不是 fs 工具实际解析所用的会话工作目录。

## 决策

适配器把每个待检查路径解析为 `ctx.fs.processPath(await ctx.fs.resolve(path, { cwd }))`，其中 `cwd` 来自 `ctx.workingDirectory.ensure(agent)`，并把该解析函数传给 `decideDeny`。守卫不再自行规范化路径，因此被分类的路径就是后端打开的 canonical 目标；后端无法解析的路径一律拒绝。工具识别新增 `read_image`、`lsp`（源文件以及被索引的工作区 cwd）与 `present`（每个 `files[].path`），其他任何带 `file_path` 参数的工具都按读检查，遵循 `file_path` 约定的新文件工具无需修改名单即被覆盖。

## 备选方案

**装饰 `ctx.fs` 并对每个操作授权。** 否决：非工具调用的 harness 内部读取（`$DSH_HOME` 下的技能目录、会话持久化、spill）使用同一服务且位于用户授权之外；`grep`/`glob` 通过 ripgrep 子进程读取而非 `ctx.fs`。只在 `ctx.fs` 上设防既会破坏这些读取方，又漏掉搜索。按执行粒度设防则要求守卫持有工具管线未暴露的执行级上下文。

**保留 `canonicalize` 并增加工具名。** 否决：每个已列出的工具仍存在字面与物理解析不一致。

## 影响

`dsh-directory-guard` 除 `tools` 外还注入 `fs` 与 `workingDirectory`。名称与 `Object.prototype` 成员冲突且带 `file_path` 的工具改为按读检查，不再放行。Linux 的 systemd 挂载命名空间仍是权威边界；在 macOS 上本插件是主要的进程内边界。

## 验证

`plugins/dsh-directory-guard/tests/guard.spec.ts` 通过 `dsh-fs-local` 解析，覆盖 `read_image`、`lsp`、`present`、未列出的 `file_path` 工具、符号链接后接 `..` 的读、写、编辑与 grep，以及无法解析的路径。挂载用例在已挂载的 `LocalFileSystem` 上运行 `tools/pre-execute` waterfall，且工作目录与会话头 cwd 不同。
