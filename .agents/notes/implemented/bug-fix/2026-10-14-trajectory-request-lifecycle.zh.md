# Agent Note: Trajectory 请求生命周期以落定状态为准，而非流存在性

状态：implemented

[English](2026-10-14-trajectory-request-lifecycle.md) | 中文

## 问题

Trajectory 助手 Definition 用错误的见证推导请求状态与流式输出。请求要到首个可见分片到达才出现，已受理但尚无输出的模型请求完全不渲染。一次已记录的 `llm/retry` 会立刻把请求翻成 `error`——进行中的重试看起来像已失败的请求——而仅含用量的分片（没有助手块）会物化一个空 partial，而不是保持等待中的请求。被中断的助手消息在步骤边界之前一直保持 `complete`/`running`，请求占位也被当作已完成的助手结果展示，给出虚幻的结果链接。

## 决策

请求记录拥有生命周期；流分片只负责填充。`buildViewNode` 在 `step/start` 加载后即发出 `running` 请求，早于任何输出。状态由落定见证推导：物化的最终消息使请求落定（消息 `interrupted` 时为 `error`，否则为 `complete`），步骤边界闭合且无最终消息时落定 `error`，其余情形——等待输出、流式生成、重试中——都保持 `running` 且 `completedAt: null`。重试事实（`retry`、`maxRetries`、`retryDelayMs`、上次尝试的 `error`）作为历史搭载在请求上，永不改变当前状态。

- `TrajectoryPartialAssistant` 在 `PartialAssistant` 上扩展 `timing`（`stepStartTime`/`firstTokenTime`），`llm/retry` 跨尝试保留已记录的 `firstTokenTime`，因此 TTFT 在恢复前后都从步骤起点计量。
- 只有物化块存在时才产生 partial；仅含用量的分片保持 `partial: null`，请求仍以 `running` 携带其用量。
- layout 为被打断的助手格标记 `isError`，流式指标优先取 partial 计时而非 node 计时；`TrajectoryView` 把 partial 计时透传给时间线，并对有落定消息却无请求记录的助手节点按其 `interrupted` 标记编号。
- 检查器区分 `details.lastAttemptError`（历史，中性样式）与 `details.error`（当前失败，错误样式），定位助手结果链接时跳过仅含请求的占位。

## 备选方案

**继续以分片到达作为请求的诞生。**那样每个修复（重试状态、仅用量分片、中断落定）都各自重新推导同一套生命周期；上游契约——`step/start` 即发布、仅在消息或边界处落定——只在一处声明一次。

**把重试做成独立状态。**重试是仍在运行的请求的细节，不是生命周期状态；检查器显示尝试计数与上次失败，状态行在响应落定前保持等待中。

## 后果

静默的模型请求从受理起可见，重试中的请求显示为等待中并附带尝试历史而非失败，中断输出无论其步骤起点是否加载都可作为失败检查。请求上的 `errorCode`——上游在 `7520fe94e14` 为本地化 AUTH 文案加入的提供商代码通道——仍是相邻缺口，由审计单独跟踪。

## 验证

`conversation-definitions.client.spec.ts`——输出前的等待请求、重试保持 `running` 直到落定、仅用量分片保持等待请求、中断响应在边界前落定 `error`、partial 携带计时。`layout.client.spec.tsx`——中断格携带 `isError`、流式格暴露已记录的开始/TTFT 指标。`table.client.spec.tsx`——请求占位不提供结果链接；双语言下重试历史与当前状态分离。`views.client.spec.tsx`——步骤起点未加载时的落定状态。160 个 `ui-trajectory` 测试通过。

## 相关

- [Trajectory 基于注册式 Conversation Context 组装数据](../architecture/2026-08-11-trajectory-conversation-context-assembly.zh.md)——本生命周期契约所在的 Definition。
- [轨迹检查记录表](../feature/2026-07-27-trajectory-inspection-ledger.zh.md)——请求与 partial 记录所注入的视图模型。
