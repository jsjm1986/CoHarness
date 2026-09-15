# Agent Note：下一次请求的持久化模型选择

状态：已实现

[English](2026-09-13-durable-model-selection.md) | 中文

## 问题

Web 模型选择器只把会话的选择保存在进程内存里。当 Session 在选择与将要消费它的请求之间转冷时，恢复会按折叠出的 `request/header`（即上一条路由）或部署默认值重建选择，静默丢弃用户已经做出的选择。早前的[目录与选择决策](2026-07-15-llm-model-catalog-and-acp-selection.zh.md)按"模型可见即须落日志"的规则把选择留在内存中，但一个待生效的选择并不是临时 UI 状态：它决定下一个请求使用哪条路由，因此属于请求重建的一部分。

## 决策

`model/selection` 是由 API 代理包声明的 `SessionEventMap` 成员。其载荷是完整校验过的 `ModelSelection`——provider、model 与可选的 adapter 侧 reasoning effort——由代理的 `selectForNextRequest` 在 `session.selectModel` 接受切换时追加。该事件仅入日志：不带 `surfaceOp`，不产生派生消息，也不会物化一个草稿 Session。它是 required-on-read 而非 `ignorable`，因为丢弃它的读取方会把下一个请求的路由重建错。

`modelSelection` 投影折叠出客户端需要的两个值：`lastUsed`——最近一条 `request/header` 已消费的选择，以及 `pending`——尚未被消费的后续选择。其 wire 视图发布 `{ lastUsed, next }`，其中 `next` 回退到 `lastUsed`。

代理的会话级选择仍按每次读取时的同一顺序解析，只新增一层：本进程记录的或从 `pending` 恢复的选择，其次是最新落日志的 `request/header`，最后是 Agent 的实时默认值。一条 provider、model 与 effort 全部匹配的已提交 `request/header` 会通过 `session/event` 流退役 pending 值，使持久化意图与执行缓存共享同一消费点。从 header 恢复出的、由 adapter 默认填充的 effort 不会被当作显式选择读回，保持了调用方选择与 adapter 解析之间的区分。

未组合投影注册表的部署保留持久化记录，但按 header/默认值回退恢复，与代理其他单元对可选注册表的姿态一致。项目作用域授权不变：持久化事件记录的是会话本地选择，而部署级默认值保存仍仅限个人作用域。

## 已考虑的替代方案

**选择只留在内存，直到请求消费它。** 这是先前的立场。它使冷恢复丢失用户已经提交的选择，也让 models RPC 无法在被重新激活的 Session 上报告待生效的选择。

**把事件标记为 `ignorable`。** 静默跳过是错误读取而非无损读取——pending 路由正是下一个请求必须使用的路由。

**从最近的 `request/header` 派生 pending。** 那是 `lastUsed` 层，不是意图：在请求出现之前落日志的选择没有 header 可读。

## 结果

- 冷 Session 恢复用户最近提交的选择，跨进程重启与注册表重组保持一致。
- 每个 `model/selection` 事件都可被仓库内任何构建读取，因为该类型进入了 `KNOWN_SESSION_EVENT_TYPES`；仓库外读取方面临与任何未知的必需类型相同的 required-on-read 拒绝。
- pending 层在匹配的 header 提交之前始终优先于最近的 header，因此在在途请求期间做出的选择不会回溯性渗入该请求的路由。
- 客户端载体通过历史基线与 `session/projection` 帧收到 `{ lastUsed, next }` 视图，无需任何域专属的客户端代码。

## 验证

`packages/host/apiproxy/tests/api-proxy-models.spec.ts` 覆盖 `selectModel` 的持久化落日志、pending 对已记 header 的恢复优先、匹配 header 的退役、非匹配 header 下的保留，以及 adapter 默认 effort 守卫。`packages/client/connection/src/client/fixture.ts` 为回放 fixture 镜像同一折叠，包括基线与逐事件的 `session/projection` 帧。
