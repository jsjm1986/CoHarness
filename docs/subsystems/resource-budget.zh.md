# 资源准入

[English](resource-budget.md) | 中文

[resource-budget 包](../../packages/context/resource-budget/README.zh.md)定义节点范围的资源许可及其执行归属义务。

## 许可记录

`ResourceKind` 选择 `model` 或 `process`；终端消耗进程许可。

`ResourceOperationId` 是提供方生成的品牌化身份，标识一个排队中或已接纳的操作。

`ResourceRequest` 携带 `kind`、可选取消 `signal`、可选品牌类型 `sessionId` 和 `origin` 意图（`execution`、`interactive` 或 `infrastructure`）。提供方在排队前捕获已验证的归属，不接受调用者指定的操作者或项目身份。

`ResourceLease.signal` 取消所属执行，但不释放占用。等待 `release()` 报告已确认的静止状态；等待 `uncertain()` 保留占用，直到之后的精确完成或已确认的 Runtime 停止。报告不确定状态后，来自调用方和提供方的取消仍然有效。连接断开不能证明执行已停止。

`./wire` 入口定义有界远程消息和已提交的策略。[包参考](../../packages/context/resource-budget/README.zh.md#remote-coordination)说明操作归属与 Gateway 受限的完成认证。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxresourcebudget--resourcebudget-abstract-seam"></a>

### `ctx.resourceBudget` — `ResourceBudget` (abstract seam)

Provider-owned node budget; standalone compositions may omit this service.

```ts cordis-catalog
/**
 * Wait for one bounded, fairly scheduled reservation before execution.
 * @param request - resource, cancellation and optional executing Session.
 * @returns a permit retained until the caller proves execution quiescence.
 * @throws when admission is refused, canceled, expired or unavailable.
 */
abstract acquire(request: ResourceRequest): Promise<ResourceLease>
```

Source: [`packages/context/resource-budget/src/index.ts`](../../packages/context/resource-budget/src/index.ts)
<!-- END GENERATED cordis-surface -->
