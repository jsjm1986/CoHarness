# 执行资源准入

[English](resource-budget.md) | 中文

[Resource Budget 定义](../../packages/context/resource-budget/README.zh.md) 描述在执行前获取、并在清理期间保留的预留。其抽象服务不提供调度器。包参考负责提供方组合与消费者的释放义务。

<a id="resource-types"></a>
## 资源类型

[`ResourceKind`](../../packages/context/resource-budget/src/types.ts) 区分 `model` 与 `process` 预留。持久终端消耗进程容量；没有独立的工作线程种类。

[`ResourceRequest`](../../packages/context/resource-budget/src/types.ts) 包含资源种类、可选取消信号以及可选的品牌化 Session id。已验证的操作者与项目事实由提供方解析。

[`ResourceLease`](../../packages/context/resource-budget/src/types.ts) 通过 `release()` 报告已证明的静止状态，或通过 `uncertain()` 报告未确认的清理结果。不确定性保留资源占用；传输断开不是释放证明。

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
