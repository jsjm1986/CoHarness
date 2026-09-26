# 计算机操作

[English](computer-use.md) | 中文

计算机操作让模型通过配置的提供方观察并操作本地桌面。DSH 的共享能力称为 **computer use（计算机操作）**；**Cua Driver** 是上游实现的名称。

## 选择提供方

在同一组合中挂载 [`dsh-computer-use`](../../packages/computer-use/computer-use/README.zh.md) 和一个提供方。两个 Cua Driver 提供方都是公开发布到 npm 的实验性包，均需显式启用。

| 提供方 | 运行时 |
|---|---|
| [Cua Driver MCP](../../packages/experimental/computer-use-cua-driver-mcp/README.zh.md) | 通过 MCP 连接已安装的 `cua-driver` 可执行文件 |
| [Cua Driver 原生](../../packages/experimental/computer-use-cua-driver-native/README.zh.md) | 随 npm 依赖安装的平台原生运行时 |

各提供方提供上游工具目录。共享服务保留一个具名提供方，并拒绝第二次注册，包括相同名称。提供方通过部署授权回调执行实际操作；工具 schema 和驱动操作仍由提供方拥有。模型不能选择提供方。

## 生命周期和桌面共享

提供方在关闭工具和自有资源期间保留注册。启动失败会释放此次尝试的注册。MCP 提供方在重连期间保留注册。

一个已注册的提供方不会为某个 Session 预留桌面。调用方负责协调跨 Session 和独立 DSH 进程的完整观察、操作和验证流程。取消调用无法撤销桌面已收到的输入。Gateway 运行时仅当节点声明交互桌面时才挂载提供方（见[托管桌面](../../gateway/deploy/README.zh.md)）；受管操作随后要求活动桌面政策和活动 Agent，缺少政策时拒绝，独立本机组装则保留操作者权限。政策取消传入驱动，并阻止发布迟到结果。

`computerUseAuthorization` 上的可选确认控制器通过[会话 API](../../packages/host/apiproxy/README.zh.md) 处理当前用户读取与明确操作。[Gateway 执行提供者](../../packages/context/gateway-execution/README.zh.md) 负责活动根会话继承、资格核验及根工作流租约。浏览器消费者从 `dsh-computer-use/types` 导入确认数据，不加载 Host 服务声明。

## 结果和平台要求

工具使用常规执行流程和 Session 日志。支持图像的模型路由在挂载附件存储时接收持久化截图；不支持图像的路由接收现有 MCP 图像诊断。提供方 README 负责说明安装、权限和平台限制。

[决策记录](../../.agents/notes/implemented/architecture/2026-09-12-computer-use-provider-registration.zh.md)解释只负责注册的服务和两个 Cua Driver 集成。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcomputeruse--computeruseregistry"></a>

### `ctx.computerUse` — `ComputerUseRegistry`

Owns one optional provider registration in the shared computer-use service.

```ts cordis-catalog
/**
 * Execute a driver call under the deployment's desktop policy.
 * Managed runtimes never recover local desktop authority when their policy unloads.
 * @param execution - actual tool caller and cancellation.
 * @param operation - native or MCP operation after authorization.
 * @returns the authorized driver result.
 */
async run<T>(execution: ToolExecution, operation: (signal: AbortSignal) => Promise<T>): Promise<T>

/**
 * Reserve the sole provider slot until the contribution is disposed.
 * A second registration fails even when it repeats the current name. Providers
 * must stop their tools and await owned work before releasing this registration.
 * @param name - provider-owned name used in registration diagnostics.
 * @returns the effect disposer for this exact registration.
 */
register(name: ComputerUseProviderName): () => Promise<void>
```

Types: [ToolExecution](tools.zh.md)

Source: [`packages/computer-use/computer-use/src/index.ts`](../../packages/computer-use/computer-use/src/index.ts)

<a id="ctxcomputeruseauthorization--computeruseauthorization"></a>

### `ctx.computerUseAuthorization` — `ComputerUseAuthorization`

The desktop policy owns authorization and the lease for the complete driver call.

```ts cordis-catalog
/**
 * Verify the actual actor, then hold desktop authority until the call settles.
 * @param execution - exact tool execution, including its live Agent and cancellation.
 * @param operation - driver effect; the supplied signal also carries revocation and lease loss.
 * @returns the result only while the grant remains valid; cleanup is awaited on rejection.
 */
run<T>(execution: ToolExecution, operation: (signal: AbortSignal) => Promise<T>): Promise<T>
```

Types: [ToolExecution](tools.zh.md)

Source: [`packages/computer-use/computer-use/src/index.ts`](../../packages/computer-use/computer-use/src/index.ts)
<!-- END GENERATED cordis-surface -->
