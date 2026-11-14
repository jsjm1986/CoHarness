# Agent Note：上游 fs 变更词汇与 apply_patch 吸收

状态：已实现

[English](2026-11-25-upstream-fs-mutations-and-apply-patch.md) | 中文

## 问题

上游 rc.3 的特性集新增了服务级移动/删除/补丁变更与 Codex 风格的 `apply_patch` 模型工具，但本地 `ctx.fs` Service Definition 只暴露 `writeText`/`editText`，`dsh-fs-patch` 库交付后无人消费。本地 fs 分歧使整文件替换不安全：`fs-local` 拥有 realpath 派生的 `targetKey` 身份、受防护的 `readByteRange`、`watch`、POSIX 物理遍历、`expandHomePrefix` 家目录展开以及上游没有的有界 diff 基准。SSH helper 与客户端互相严格校验线路词汇，不加协议提升就新增三个 RPC 会让旧 helper 静默丢弃新方法。

## 决策

在 `writeText`/`editText` 之外，为 `ctx.fs` Service Definition 增加 `patchText`、`deleteFile` 与 `moveFile`，以 hunk 粒度吸收上游（dsh-v0.2.2-rc.3）的提供方实现、沙箱围栏、SSH 线路词汇以及 `apply_patch` 模型工具，同时保留本地分歧。

`FileSystem` 新增三个抽象方法，与既有变更一样接受可选 `expected` 版本防护与 `SandboxExecutionPolicy` 参数。`fs-local` 在 `applyHunks`（来自 `dsh-fs-patch`）、非递归 `removeFile` 以及按 `targetKey` 字典序锁定两个不同目标的「先目标后源」移动之上实现它们。`moveFile` 刻意是两个效果而非一个事务：目标发布后源删除失败时返回 `sourceDeleted: false` 与结构化 `sourceFailure`，而不是假装原子性。`fs-sandbox` 为全部五种变更设围栏；移动在任何效果发生前同时检查源与目标。`fs-ssh` 把三个操作映射为 `fs.patch`/`fs.delete`/`fs.move` helper RPC，并把 helper 线路协议提升到 3。`apply_patch` 工具仅在 `enableApplyPatch`（默认关闭）下注册，按序提交操作并如实报告部分结果，同时贡献 `TOOL_APPLY_PATCH` 提示段（顺序 1350）。

宿主 errno 失败现在统一经由导出的 `fsErrorFromErrno`/`FS_ERROR_CODES` 分类，因此每个解析/stat/列出/读取/写入失败都携带稳定的 `FsError` 错误码，SSH 提供方也用同一列表校验远程错误码。新的 `fs/delete-intent` waterfall 加入意图词汇：删除防护走它，补丁与移动源防护走 `fs/edit-intent`，移动目标防护走 `fs/write-intent`。

## 后果

- `FileSystem` 的实现方必须补三个方法；仓库内所有 fake 获得了类型化 `Promise<never>` stub 或真实行为。
- 本地提供方触碰宿主的每一处 Node errno 失败现在都是类型化的；原先对抛出错误原始 `code` 字段做匹配的代码，现在看到的是 `FsError`，原错误在 `cause`。
- 早于协议 3 的 SSH helper 会拒绝 hello 握手——helper 与客户端需一起部署。
- `apply_patch` 保持 opt-in；未配置 `enableApplyPatch` 的组合看不到 schema 或提示段变化。

## 备选

- **整文件替换为上游版本**——否决：会静默丢弃 realpath 身份、受防护字节读取、watch 支持与本地测试钉住的物理遍历语义。
- **沿用上游 `readByteWindow` 命名**——否决：本地 `readByteRange` 已提供带 FileHandle+`O_NOFOLLOW` 防护的有界窗口原语，改名只会无谓搅动消费方。
- **把移动建模为单个原子原语**——否决：本地暂存协议与 SSH helper 都无法跨路径原子地「发布并删除」；如实报告 `sourceDeleted` 才保住调用方真正需要的不变量。

## 验证

- `pnpm exec vitest run packages/fs`——930 个测试通过，包括 `patch-mutations.spec.ts`（本地提供方移动/删除/补丁覆盖）、`errno.spec.ts` 以及三种模式的沙箱围栏矩阵。
- `pnpm exec vitest run packages/ssh`——314 个通过，helper fixture 与三个本地独有 spec 已更新到协议 3。
- `pnpm exec vitest run packages/fs/tool-fs`——474 个通过，覆盖 `apply_patch` 注册、输出/展示、提交顺序与部分效果报告。
- `pnpm run verify-cordis-catalog`——在 `LINK_MAP` 登记 `FsDeleteOutcome`/`FsMoveOutcome`/`FsMoveSourceFailure`/`PatchHunk` 后通过；生成的 `filesystem.md`/`.zh.md` 已提交。
- `pnpm run verify-translation-pairing`——2181 对一致；`verify-export-jsdoc` 干净。
