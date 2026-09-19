# Agent Note: 脱离会话的持久化自动化触发

Status: proposed

[English](2026-09-18-session-independent-automation-triggers.md) | 中文

## 问题

`packages/schedule/schedule/src/types.ts:111` 把 `ScheduleDeliveryMode` 钉死为 `'session-local'`，注释写明「Fixed v1 delivery boundary: the original session must be live」。在会话里创建的提醒，随该会话一起消失。这对「我继续干活时二十分钟后提醒我」是正确的，但对自动化是致命的——自动化按定义就必须能活过定义它的那次对话。

这个绑定不是偶然的。源码里有四条事实：

1. `schedule/src/index.ts:51` 只在 `agent/created` 时构造 `ScheduleRuntime`，且只对 root agent（`ctx.agents.roots().includes(agent)`）。
2. `schedule/src/runtime.ts:93-94` 持有 `Agent` 实例；`:161-162` 每次驱动都用 `isLive()` 硬门控（`agents.get(id) === agent` 且仍是 root）。
3. 定时器是**进程内 `setTimeout`**（`runtime.ts:79`，上限为 `:22` 的 `MAX_TIMER_DELAY_MS`）。**全仓没有任何持久定时器**。重启后调度能被重新推导出来，只是因为 agent 被重建、`start()` 重新 fold 了 session 日志（`:242`、`:209`）。
4. 唯一的投递出口是 `runtime.ts:273` 的 `agent.followup(message)`，它开一轮模型请求。不存在绕过 `Agent` 的投递路径。

第 4 条才是真正的约束。「不开 agent 跑一轮」没有现成路径：

- `ReactLoopAgent` 必须传 session（`agent-loop/src/agent.ts:91-97`）；发起链 `send/followup`（`:126`、`:143`）→ `wakeDriver:200` → `turn:287` → `step:386` → `llm.stream:400` 全程依赖 agent。
- ACP 同样要建 agent（`acp/src/index.ts:60`；`session.ts:128` `agents.create`、`:149` `agents.resume`）。
- 全树唯一不需要 agent 的模型调用是直接 `ctx.llm.stream`（`session-title-llm/src/index.ts:273`、`compaction-basic/src/summarizer.ts:161`）。它没有 turn、没有 step、没有工具，不构成一轮 agent。

所以缺口不是「加一个投递模式」，而是**没有任何东西站在触发器背后**。

## 提案

沿着源码已经画出的那条线拆分 `schedule`：复用 domain，替换 runtime。

**原样复用。** `foldScheduleEvents`（`domain.ts:628-644`）、`resolveEveryOccurrence`（`:520-552`）、`ScheduleChange` v1 联合类型（`types.ts:105`）以及 11 种稳定错误码。漏发策略已经定好，应当逐字继承：固定周期规则跳过漏掉的周期（`:537-538` 只取最近一次到期），一次性提醒则保持 overdue、恢复后补发（`runtime.ts:43-47`）。

**新建：常驻触发持有者。** 一个非 agent-scoped 的常驻插件，`inject` 含 `agents`、`sessions`、`llm`、`tools`、`sessionPersistence`。触发时重放 `packages/bundle/headless/src/index.ts:170-215` 已经证明可用的那串调用——`agents.create`（`:185`）→ `agent.followup`（`:200`）→ `await agent.whenIdle()`（`:204`）→ `sessions.flush`（`:208`）——然后 dispose handle，而不是退出进程。`AgentRegistry.resume()`（`core/agent/src/index.ts:415`）是挂到已有会话的原语；注意 agent id 必须等于 session id（`core/agent/src/index.ts:465`）。

**新建：项目级的触发器存储。** 这部分没有先例。`collaboration-gateway` **没有任何本地项目级数据结构**：项目语义完全来自远端 principal claims（`context/collaboration-gateway/src/index.ts:107-121`）经 HTTP 转发，`GatewayRuntime` 只带一个 `sessionCreations: Map<SessionId, ...>`（`gateway-runtime/src/index.ts:412`），键是 session 而非 project。照 `gateway/deploy/postgres/migrations/012_document_catalog.sql` 已确立的租户级数据形状来做：`organization_id` + `scope_kind (personal|project)` + 血缘列 + append-only 操作轨迹。

**预算。** 复用既有的三主体配额模型——`role_quotas`（`001_initial.sql:198`）、`user_quotas`（`:206`，`inherit|unlimited|custom`）、`project_quotas`（`003_project_collaboration.sql:116`），以 `token_limit` 与 `company_cost_limit` 度量，配 `project_usage_alerts`（`:122`）的 80/100 阈值。新增 `automation` 作为第四主体。**不要另造一套预算体系。**

## 触发记录不是 session 事件

明确写出来，因为它擦到了 model-visible ⟺ logged 这条规则。触发记录是平台调度状态，不是模型看到的内容，它从不进入 `request.messages`，因此活在 session 日志之外。它**启动的那次运行**仍完整记录在自己创建的会话里。我们真正在意的不变式——模型看到的一切都可重建——不受影响。

## 备选方案

**让 `ScheduleRuntime` 活过它的 agent。** 否决：runtime 由 `agent/created` 构造、每次驱动都被 `isLive()` 门控。要让它活过 agent，要么持有一个已 dispose 的 `Agent`，要么重建所有权模型。不如把它留在 session-local 这一种情形上。

**扩展 `JobRegistry`。** 否决，理由是范围而非设计。`JobRegistry`（`jobs/jobs/src/index.ts:62`）刻意是 owner-relative 的，其本地实现是 process-local，且没有运行的持久记录。它是「已开始的工作」的句柄，不是调度器。它是本提案的好*消费者*，不能替代本提案。

**不经 agent 轮次、直接 `ctx.llm.stream` 投递。** 否决：没有 turn、没有 step、没有工具。不能调用工具的自动化不是自动化。

**整体 fork `schedule`。** 否决：这会让日后必须与上游重新对齐的面积翻倍。domain/runtime 拆分把改动限制在「一个新 runtime + 一个新存储」。

## 验收标准

- 以 `session-independent` 投递创建的触发，在创建进程退出后仍能触发；由测试验证：创建一个、拆掉 runtime、从新进程观察到投递。
- `resolveEveryOccurrence` 行为不变：固定周期规则跳过漏发，一次性触发恢复后补发一次。
- 触发记录位于 session 日志之外；它启动的每次运行都是一个普通会话，可从自身日志重建。
- 自动化走与用户、角色、项目相同的配额通路，`automation` 作为新增主体。
- `ScheduleDeliveryMode` 增加 `'session-independent'`；`'session-local'` 保持默认且行为不变。
- 下述 at-least-once 缺口在同一次改动中闭合。

## 风险

**at-least-once 缺口已经存在。** `runtime.ts:273` 先调 `agent.followup()` 开轮，`:282` 才 append dispatch 记账。两者之间崩溃则记账丢失而投递已发生，记录保持 active，一次性提醒在恢复后被再次投递。固定周期规则不受影响（漏发直接跳过）。任何新的投递路径都必须把顺序反过来——**先记 dispatch，再投递**——而且现有 runtime 也要一并修，不只是新的那个。

**常驻持有者是一个新的失效域。** 它持有定时器、开轮次、花预算，且没有人在环里。它需要任何长跑表面都需要的护栏：重启策略、并发上限，以及一个「当前挂起什么」的可观测视图。

**项目级存储是真正新的东西。** 与投递路径不同，它在树里没有模板。预计 schema 会是本次改动中被评审最多的部分。

**上游表面。** `schedule` 是 harness 包，上游可能改动它。domain/runtime 拆分意味着我们复用的正是最可能保持稳定的部分，而新 runtime 是我们自己的——但任何新包在落地前都要在 `scripts/upstream-sync.json` 登记主权。
