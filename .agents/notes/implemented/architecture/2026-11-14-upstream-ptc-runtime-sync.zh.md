# Agent Note：从 dsh-v0.2.2-rc.3 吸纳的上游 PTC 运行时重构

状态：已实现

[English](2026-11-14-upstream-ptc-runtime-sync.md) | 中文

## 问题

上游 `rc.2..v0.2.2-rc.3` 将 `ptc-runtime-node` 的 `persistent.ts`/channel 设计替换为模块化的 evaluator/execution/worker/RPC 架构；本地包仍在运行旧设计，需要该重构以及本 fork 要求的 API 适配。

## 决定

整包吸纳上游版本，仅重放本地 API 适配。

保留的本地适配：

- 本地 `ctx.subprocess.spawn` 为异步；所有 spawn 调用点均 await，两个假设
  同步句柄的测试已调整（`persistent.spec.ts` await 绑定的 spawn；
  `host-failures.spec.ts` 将伪造的传输丢失推迟到宏任务——注意该 spec
  文件的 `setImmediate` 导入是 `timers/promises` 变体，直接写
  `setImmediate(cb)` 回调永远不会执行）。
- `SandboxExecutionPolicy` 尚无 `additionalWritableRoots`；在 sandbox 批次
  落地该字段前，execution 原样克隆 policy。
- `HarnessError` 来自 `@deepseek-ai/dsh-llm`（上游的 `dsh-error` 包本地不存在）。
- `sandbox-policy` 通过本地 `ctx.sessionProjections.register({ key })` /
  `stateOf(session, key)` API 注册 keyed projection，而非上游返回句柄的变体。
- 按同步取舍策略排除了新增 locale（`de/es/fr/ja/pt/ru`）。

## 后果

该重构依赖的上游 append 守卫已回移植到 `packages/core/session`：
`pending | dispatching | complete | failed` 四态 announcement 状态机与
`WeakMap<Session, SessionEntry | null>` 附着表，使 detach 后或
`session/created` 完成前的 append 显式报错，而非静默脱离 store。

## 备选方案

- **只摘取 evaluator 部分**——拒绝：configuration、evaluator、worker 与 RPC 模块在新架构的共享类型上互锁，整包吸纳并重放本地适配是唯一安全路径。

## 验证

`vitest run packages/ptc-runtime/ packages/sandbox/ packages/core/session/`：
64 个文件、1470 个测试全部通过（7 项为平台条件跳过）。
