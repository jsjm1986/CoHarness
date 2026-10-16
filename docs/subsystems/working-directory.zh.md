# 工作目录

[English](working-directory.md) | 中文

Session 的当前目录由 [`dsh-working-directory`](../../packages/session/working-directory/README.zh.md) 拥有。不可变 header 标识原始项目；`working-directory/change` 记录后续目录相关操作使用的有效目录。生成的[持久化目录](../persistence-catalog.zh.md) 拥有事件声明。

## 目录选择

`ctx.workingDirectory.get(session)` 读取日志中的值。`ensure(agent)` 验证它，并在目录消失或不再满足边界约束时恢复原始项目。`set(agent, path)` 验证并记录请求的变更。`resolve(agent, path)` 针对当前目录规范化候选路径但不提交。header 没有目录的 Session 使用配置的运行时回退目录；回退目录不可用时返回错误。

变更仅影响一个 Session，且在符号链接解析后必须留在原始项目内：`set` 与 `resolve` 拒绝项目外路径，`ensure` 在记录值越界时恢复原始项目。相对路径文件系统操作、新启动的进程、指令发现、技能和文件补全使用当前目录。已有终端和持久 shell 保留自己的目录。沙箱可写根目录与项目归属继续绑定原始项目。

校验经由 Session 执行世界的文件系统完成：绑定 SSH 的 Session 在其远端 realm 内解析与检查，该文件系统缺失时直接失败，绝不落到主机文件系统。`ensure` 遇到文件系统传输故障时保留记录值并告警，而不是提交替代目录。

## 模型上下文

初始值与后续当前值通过必需的用户上下文快照到达模型，即使可选运行时上下文被禁用也不例外。每次已提交变更都会尝试通过普通 Agent 收件箱排入通知；取消或销毁可能丢弃尚未进入请求的通知。目录事件仍然保留，下一次获准进入的请求会收到当前值。目录上下文不进入系统提示词。[`working_directory`](../../packages/session/tool-working-directory/README.zh.md) 提供一个可选的 `cd` 参数，SDK 提供 `session/working-directory/get` 与 `session/working-directory/set`。`{{cwd}}` 提示变量对既有 persona 保持原始项目语义；有效目录只通过该用户上下文到达模型。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxworkingdirectory--workingdirectoryservice"></a>

### `ctx.workingDirectory` — `WorkingDirectoryService`

One owner for each Session's effective directory and its model-visible changes.

```ts cordis-catalog
/**
 * Read the committed directory without filesystem I/O.
 * @param session - Session whose directory is requested.
 * @returns its effective absolute directory.
 */
get(session: Session): string

/**
 * Validate the current directory and restore the original project when it disappeared.
 * @param agent - live or unpublished Agent owning the Session.
 * @param signal - cancellation for filesystem inspection.
 * @returns the existing directory; recovery is committed before fulfillment.
 * A notice failure is warned without reverting the committed state. A provider
 * transport failure returns the recorded directory without committing anything
 * and warns once per Session until a later validation succeeds.
 * @throws when the original project is also unavailable.
 */
ensure(agent: Agent, signal?: AbortSignal): Promise<string>

/**
 * Canonicalize a candidate directory under the project root without committing.
 * @param agent - live or unpublished Agent owning the Session.
 * @param path - absolute path or a path relative to its current directory.
 * @param signal - cancellation for filesystem inspection.
 * @returns the canonical absolute directory, guaranteed inside the project root.
 * @throws when the path is not an existing directory inside the project.
 */
resolve(agent: Agent, path: string, signal?: AbortSignal): Promise<string>

/**
 * Change one Session's directory without changing existing processes or permissions.
 * @param agent - live or unpublished Agent owning the Session.
 * @param path - absolute path or a path relative to its current directory.
 * @param signal - cancellation before the durable change.
 * @returns the canonical absolute directory, committed before fulfillment.
 * A notice failure is warned; the next request still receives the committed directory.
 * @throws when the requested path is not an existing directory inside the project root.
 */
set(agent: Agent, path: string, signal?: AbortSignal): Promise<string>
```

Types: [Agent](core.zh.md) · [Session](session.zh.md)

Source: [`packages/session/working-directory/src/index.ts`](../../packages/session/working-directory/src/index.ts)
<!-- END GENERATED cordis-surface -->
