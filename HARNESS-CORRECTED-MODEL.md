# CoHarness 源码级建模（更正版）

生成时间：2026-09-18
方法：4 路源码深读 + 主代理独立复核 + Gateway 数据面核查。每条结论附 `文件:行号`。
与 `PROJECT-UNDERSTANDING.md` 的关系：那份回答"项目是什么"，这份回答"能往哪儿扩展、不能往哪儿扩展"。

---

## 一、被推翻的建模

前几轮给出的企业插件模型来自设计直觉，源码核查后有五条不成立：

| 此前主张 | 源码事实 |
|---|---|
| 插件以「实体 / Entity」为锚 | `packages/**/src` 全文 grep `entity\|Entity` **零命中**。harness 里没有实体这个一等概念 |
| 「进程」是插件的一个维度 | cordis 插件默认 in-process；进程是 **Provider 的选择**。worker-thread README 明写"不是安全沙箱" |
| preset 可承载字段 / 表结构 | preset 客户端行只有 `id/trust/isDefault/name/description/broken`（`packages/preset/agent-presets/src/types.ts:11-25`）。**无能力声明、无实体、无 schema**。（`capabilities` 全包仅在注释中出现，`index.ts:386`） |
| subagent 有 7 个 provider | 实际 **6 个注册型 provider + 1 个共享驱动库**（`subagent-in-process-driver` 非 provider） |
| 「扩展插件只依赖 Definition」是强制约束 | **约定级**，无 lint / 无类型强制。存在反例：`fs-sandbox` 直接 import `fs-local`（Provider→Provider 继承） |

---

## 二、正确的模型

### 2.1 四层运行时

| 层 | 位置 | 关键原语 |
|---|---|---|
| L0 运行时 | `vendor/cordis` | `Context`(Proxy) / `Fiber` / `effect` / `isolate` + `filter` |
| L1 作用域 | `packages/core/scope` | `createScope` / `ScopeKey` / `bindScopeParent` / `scopeChainOf` |
| L2 能力接缝 | `packages/**` | `abstract class X extends Service` = Definition；子类 = Provider；`ctx.x` = Consumer |
| L3 产品层 | preset / ui-slots / collaboration / jobs / schedule | 声明合并表驱动的组装 |

**L0 与 L1 的正交性**（此前混淆过）：`isolate` 只切**可见性**（谁看得见谁），`fiber` 管**生命周期**（谁随谁销毁），两者无关。`createScope` 是 harness 在 cordis `Context` 之上自建的一层。

### 2.2 声明脊：唯一的扩展机制

扩展不是注册表，是**编译期 `declare module` 合并的 8 张表**。全局唯一、无版本、同名即冲突。

| 表 | 声明者 | 消费者 |
|---|---|---|
| `Context`（cordis） | Service Definition | `ctx.x` |
| `SessionEventMap` | 任意包 | 持久化 / 投影 |
| `SessionProjectionStateMap` | 域包 | fold 状态 |
| `SessionProjectionMap` | 域包 | 前端视图 |
| `SlotMap` | 壳（唯一 declarer） | 插件 `register()` |
| `RemoteErrorDetailsMap` | 如 collaboration / agent-presets | RPC 错误码 |
| `JobKindMap` | producer 包 | `JobRegistry` |
| `MessageSourceMap` | agent-team | 消息溯源 |

**核心命题：harness 只归纳「声明」，不归纳「数据」。**

### 2.3 状态与数据的唯一合法形式

`packages/session/session-projection/src/index.ts`

- `:13` **whole-value event rule**：承载状态的事件必须携带完整的变更后状态，不得只带增量
- `:48-94` `ProjectionDefinition`：`init` / `apply` **必须同步**（异步会撕裂一致性切片）；`state` **必须是纯 JSON**（持久化缓存前置条件）；`:93` `stateVersion` 管缓存失效
- `:75-86` `wire` = 客户端视图，省略则为 host-only 单元

**含义**：一个「CRM 客户表」在 harness 内只有一种合法表达 —— 一组 `SessionEventMap` 事件 + 一个 `ProjectionDefinition`。没有 schema 注册表、没有运行时类型目录、没有实体图谱。

---

## 三、已经存在的能力（此前误判为缺失）

### 3.1 后台执行：`packages/jobs/jobs`

`src/index.ts:62` `abstract class JobRegistry extends Service`
接口：`start` / `list` / `get` / `read` / `kill` / `wait` / `onJobDone` / `onJobsChanged` / `attachController`

三条已实现的语义：
- `:47-48` owner 按 sessionId 隔离 —— 注释原话："Ids are predictable, so **authorization — not secrecy** — is the boundary"
- `:49` 结算 **first-wins**，一个终态、一轮通知
- `:67` `new.target === JobRegistry` 直接抛错，防止把抽象包当 cordis 行加载
- `src/types.ts:17` `JobStatus = running \| stopping \| completed \| killed \| failed`
- `src/types.ts:23-26` `JobKindMap` 声明合并扩展（内置 `bash` / `subagent`）

### 3.2 持久化触发：`packages/schedule/schedule`

`src/types.ts`
- `:69` `ScheduleRecord = after \| at \| every`；`:46` 固定间隔不得低于 5 分钟
- `:105` `ScheduleChange = create \| delete \| dispatch`，版本化 v1
- `:219` 以 `'schedule/change'` 事件写进 session 日志 —— 满足 model-visible ⟺ logged
- 11 种稳定错误码闭包，含 `persistence_uncertain`

**`:111` `ScheduleDeliveryMode = 'session-local'`** —— 这是全栈最关键的一处限制，见 §4.1。

### 3.3 多 agent 协作：`packages/experimental/agent-team`（私有原型）

`src/types.ts`
- `:73-83` `TeamTaskSnapshot`：`revision`（每次变更自增 = 乐观锁）、`blockedBy[]`（依赖图）、**`writeScopes: string[]`**（写范围声明，防并发互踩）
- `:100-107` `TeamMessageSnapshot`：`delivery: 'quiet' \| 'wakeup'`
- `:110-116` `TeamMessageSource`：durable mailbox **幂等去重**
- `src/index.ts:59` `TeamService extends TypertRemoteService`，`inject = ['agents','sessions','sessionPersistence','subagents']`

### 3.4 权限：不在 harness，在 collaboration

`packages/context/collaboration/src/`
- `types.ts:10` `CollaborationAction = read \| write \| manage \| approve`
- `types.ts:13` `CollaborationInteractionKind = approval \| question`
- `types.ts:19-33` participant scope = `personal` \| `project{projectId, mode: ro\|rw, canManage?}`
- `types.ts:84-89` **`claimInteraction()` 原子抢占** —— 多人同时点"批准"，只有第一个赢，其余返回 false
- `types.ts:54-59` authority 带 `expiresAt` + `AbortSignal`：授权有时效，长流必须重连
- `index.ts:84` `abstract class Collaboration extends Service`（Definition）；Provider 在 `collaboration-gateway`

**tools 侧是另一套**：单调 deny-only 的 `ToolGuard`（无 allow 结果）。两套机制不通用，勿混。

### 3.5 配额：存在，但挂错主体

Gateway PostgreSQL（`gateway/deploy/postgres/migrations`，27 个迁移，48 张表）：
- `001_initial.sql:198` `role_quotas(organization_id, role, token_limit, company_cost_limit)`
- `001_initial.sql:206` `user_quotas`（`token_mode` / `company_cost_mode` = `inherit \| unlimited \| custom`）
- `003_project_collaboration.sql:116` `project_quotas(token_limit, company_cost_limit)`
- `003_project_collaboration.sql:122` `project_usage_alerts(period_start, metric=tokens\|company-cost, threshold=80\|100)`

`gateway/src/response-budget.ts` 是 **HTTP 响应字节上限**，不是成本预算。

---

## 四、真实缺口

### 4.1 【最高】触发不能脱离会话

`packages/schedule/schedule/src/types.ts:111`

```ts
export type ScheduleDeliveryMode = 'session-local'
```

注释原文："Fixed v1 delivery boundary: **the original session must be live**."
`src/index.ts:52` 也只给 root agent 装 runtime。

**后果**：会话一死，提醒全灭。这是"插件长期使用 / 自动执行"最致命的一条 —— 自动化在定义上就必须能脱离创建它的那次对话存活。

#### 4.1.1 可行性勘察结论（源码核实）

**`schedule` 不能"扩展"，只能"抽 domain、重写 runtime"。**

- **domain 层可复用**：`foldScheduleEvents`（`domain.ts:628-644`）、`resolveEveryOccurrence`（`:520-552`）、`ScheduleChange` v1、11 种稳定错误码。
- **runtime 层不可复用**：`runtime.ts:93-94` 持有 agent；`:161-162` `isLive()` 硬门控；`:79` 定时器是**进程内 `setTimeout`**（上限 `MAX_TIMER_DELAY_MS`，`:22`）；`index.ts:51` 只给 root agent 装 runtime。**全仓无全局调度器、无持久定时器。**
- **投递出口唯一**：`runtime.ts:273` `agent.followup(message)` 开一轮模型请求。不存在不经 Agent 的投递路径。

**「无 agent 跑一轮」不存在现成路径**（已逐一排除）：
- `ReactLoopAgent` 构造必传 session（`agent-loop/src/agent.ts:91-97`），发起链 `send/followup:126,143` → `wakeDriver:200` → `turn:287` → `step:386` → `llm.stream:400` 全程依赖 agent。
- ACP 也建 agent（`acp/src/index.ts:60` inject、`session.ts:128` `agents.create` / `:149` `resume`）。
- 唯一无 agent 的模型调用是直接 `ctx.llm.stream`（`session-title-llm/src/index.ts:273`、`compaction-basic/src/summarizer.ts:161`），但**无 turn / step / 工具**，不构成一轮。

**最接近的现成模板**：`packages/bundle/headless/src/index.ts:170-215` 的 `run()` ——
`agents.create`(:185) → `agent.followup`(:200) → `await agent.whenIdle()`(:204) → `sessions.flush`(:208)。
**这就是"平台自发起一轮 agent"的完整代码。** 代价：由 CLI 启动触发（`:222`）、跑完 `io.exit` 退进程（`:214`）、无定时器、无持久触发器。复用时需改为常驻 + `handle.dispose()`。

**两处工作量被低估**：
1. **投递持有者**需新建：常驻、非 agent-scoped 插件（`inject` 需含 `agents/sessions/llm/tools/sessionPersistence`），触发时复刻 headless 三步。原语已备：`AgentRegistry.resume()` @ `core/agent/src/index.ts:415`。
2. **触发器存储需新建项目级注册表** —— `collaboration-gateway` **没有本地项目级数据结构**：项目语义全来自远端 principal claims（`context/collaboration-gateway/src/index.ts:107-121`）经 HTTP 转发；`GatewayRuntime` 只有 `sessionCreations: Map<SessionId,…>`（`:412`），键是 session 不是 project。

**提案方向**：抽 `schedule` 的 domain，新建 `'session-independent'` 投递路径（以 headless `run()` 为模板，常驻化），触发器存储挂在**项目级**（照 §4.5 的 `organization_id` + `scope_kind` + `lineage` 形状）。关键约束：
- 触发记录不再是 session 事件，须显式说明它为何不受 model-visible ⟺ logged 约束（它不是给模型看的，是平台调度状态）
- 复用 §3.5 配额模型，新增 `automation` 主体
- 幂等策略沿用 `resolveEveryOccurrence` 的先例：`every` 跳过漏发，一次性提醒恢复后补发

#### 4.1.2 勘察中发现的现存缺陷（与改造无关，独立成立）

`runtime.ts:273` 先 `agent.followup()` 开轮，`:282` 才 append dispatch 记账。
**两者之间进程崩溃 → 该次投递已发生但未记账，记录仍 active，恢复后一次性提醒会重复投递**（at-least-once）。
`every` 类不受影响（`:520-552` 只取最近一次到期，漏发直接跳过），**一次性提醒受影响**。

### 4.2 Job 无持久化、无 Run Ledger

`jobs-local` 是 process-local，重启即失。`schedule` 有 dispatch 记录，`jobs` 没有。
无法回答："这次跑到底做了什么 / 花了多少 / 为什么没产出"。

参照 `agent-team` 的 `revision` + `blockedBy` 形状，而非另发明。

### 4.3 预算没挂在自动化上

配额挂在 user / role / project 三主体（§3.5），**没有 automation 主体**。
建议：复用同一套 `token_limit` / `company_cost_limit` + `period_start` 阈值告警，新增主体类型，不另造体系。

### 4.4 无自动化级幂等 / 防环

`agent-team` 有 `blockedBy`（依赖图）+ `writeScopes`（写范围），但那是 team 语义。
自动化层需要独立的：幂等键、因果深度上限、单规则触发频次上限。

### 4.5 【根本】业务数据无家

Gateway 48 张表**全是平台治理域**（users / organizations / projects / memberships / models / quotas / usage / audit / documents / conversations），**零业务域表**（无 Customer / Contract / Invoice）。
`021_project_ui_policy.sql` 只是 `projects.ui_theme_policy`（follow-user/light/dark）一列，不是通用 UI 策略。
`012_document_catalog.sql` 是文件元数据目录（注释："File bytes remain in the runtime-owned document roots"），不是通用实体存储。

**但它给出了租户级数据的既定形状**，新增业务实体目录应照此办理，不要另发明：
`organization_id` + `scope_kind(personal \| project)` + `lineage_root_id`（血缘）+ append-only `document_operations` 操作轨迹。

---

## 五、不可破坏的边界

- Session 日志是 append-only 事实源，`seq === log.length`，`append()` 是唯一写入口
- model-visible ⟺ logged：进入模型请求的内容必须能从日志重建
- preset 组合在会话产生内容后即锁定（错误码 `'agent-preset/locked'`，`types.ts:43`）
- 上游 `@deepseek-ai/dsh-*` 包名与 `vendor/` cordis 不整包覆盖
- Gateway / ACL / Workbench / native / Landlock 为独立版本线

---

## 六、方法教训

- **README 说"范式"，`src` 才说"约束"**。建模前先读 `src/index.ts` 的 `declare module` 块 —— 那才是扩展点清单。
- **grep 零命中也是强证据**。"没有实体注册表"靠零命中确认，比读文档可靠。
- 子代理的字段名 / 计数类结论必须独立复核（本轮 5 路中 3 处需更正：`capabilities` 字段不存在、subagent provider 计数、`fs-sandbox` 反例）。
