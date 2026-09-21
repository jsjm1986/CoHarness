# Agent Note: 配置 agent 的持久化读取等待 Loader 挂载收束

Status: implemented

[English](2026-09-21-configured-agent-persistence-mount-race.md) | 中文

## 问题

Loader 条目组并发挂载子项（`EntryGroup.update` 里的 `Promise.all`），插件的构造顺序取决于模块 import 的解析先后，而非树内位置。`AgentLoop` 的配置 agent 循环在构造期同步读 `ctx.get('sessionPersistence')`：`sessionId` 分支处一次（用于选择 restore 还是 create），`createStoredSession` 里对每次 `create`/`createAgent` 再一次。`ctx.get` 是一次性严格读——模块仍在 import 的后端对它不可见。

故障形态是静默丢数据：配置 agent 正常发布并运行，但 session 从未认领写句柄，`session/flush` 没有可清空的 writer，落盘产物为零。`dsh-session-persistence-jsonl` 只要在 `agent-loop` 的 inject 依赖就绪之后才完成 import，就会稳定复现——tsx 下（`DSH_EXAMPLE_MODE=src`）的 keyless headless smoke 每次必败，而 built-`lib` 的时序恰好能赢。同一竞态也波及用 overlay 配置 `agents:` 且后端晚挂载的用户；`sessionId` 变体还会把 restore-or-create 错路由成纯 `create`，进而与已有产物撞出 `SessionAlreadyExistsError`。

## 决策

`AgentLoop` 经 `resolveSessionPersistence` 解析可选后端：先严格 `ctx.get`，未命中时调用一次 `ctx.get('loader')?.await()`——Loader 服务公开的收束等待，会排空所有条目的在途 import 与 fiber 激活——再读一次。等待发生在被跟踪的异步启动任务里，插件构造函数不会阻塞自己的挂载。

配置 agent 的构造循环现在委托给 `startConfigured`，把持久化解析移进异步启动，而不是在 apply 时同步读。`createStoredSession` 走同一解析器，覆盖配置路径与运行时路径的 `create`/`createAgent`。`resume` 保持严格读：它是 boot 后的运行时 API，契约就是无后端时抛错；配置式 resume 路径本就用 `ctx.inject(['sessionPersistence'], ...)` 正确等待。

## 备选方案

**对每个配置 agent 用 `ctx.inject(['sessionPersistence'], ...)` 等待。** 否决：`inject` 在组合本就没有持久化后端时永远阻塞——可选服务不能变成硬依赖——且 HMR 重挂会重复触发，导致重复建 agent。

**推迟到 `session/flush` 或首个 `session/event` 再认领句柄。** 否决：首个事件到达时 seed 窗口已关闭，迟认领的 writer 会从日志中段开始写，过不了 tracker 的连续 seq 校验；预发布 seed 冲刷（`appendUnstoredSuffix`）存在的原因正是这些事件不会重发。

**用 overlay 或 fixture 钉住挂载顺序。** 否决：patch 条目无法重排兄弟挂载，且该缺陷是 overlay 编写 `agents:` 时的真实产品竞态而非测试脚手架问题——只在 fixture 里修会让产品路径保持有损。该修复对上游同样适用；上游 `dsh-v0.1.6-alpha.2` 带着同样的读取。

**`resume` 运行时 API 也等待收束。** 暂缓：其契约是无后端时响亮抛错，树内也没有在组合期 resume 的调用方；配置式 resume 已经经 `ctx.inject` 等待。

## 影响

- 配置 agent 只在组合收束到能看见后端之后才发布——启动多花的是后端的挂载时间，换来不再静默丢持久化。boot 后的 `create`/`createAgent` 面对的是已收束的 loader，只多一次 `ctx.get`。
- 带 `sessionId` 的配置 agent 现在基于真实后端状态做 restore-or-create，不再竞态成 `SessionAlreadyExistsError` 或未持久化副本。
- 无后端组合行为不变：`loader.await()` 在挂载收束后返回，重读仍未命中，session 按设计不持久化。
- 关联：[激活审计笔记](../architecture/2026-09-17-loader-activation-audit-consumers.zh.md) 解释了 `loader.await()` 为何只是收束信号——挂载失败的后端在其 resolve 后依然缺席，这在此处正是正确的"无持久化"结果。
- 验证：`apps/cli/tests/profiles/headless/tests/keyless-smoke.e2e.ts` 在 `src` 与 `lib` 两种模式下通过，`agent-loop` 包套件 379 测试全绿。
