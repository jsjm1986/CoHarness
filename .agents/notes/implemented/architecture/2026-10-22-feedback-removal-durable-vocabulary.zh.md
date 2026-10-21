# Agent Note: 反馈生产者已移除；反馈事件仍为耐久日志词汇

状态：implemented

[English](2026-10-22-feedback-removal-durable-vocabulary.md) | 中文

## 问题

本部署没有任何消费方读取已记录的消息反馈或会话反馈：sidecar 存储与 Session 事件是为模型质量标注流水线而写，而 fork 中没有东西读它们。该功能仍在每条 assistant 消息行上占用一个点赞/点踩控件、一个 `/feedback` 命令、三个包、若干 Remote 端点、项目 scope allowlist 条目，以及每次发布的上游同步冲突处理成本。

## 决策

所有产生或渲染反馈的部件都已移除：`packages/feedback/command-feedback`、`packages/feedback/message-feedback`、`packages/client/ui-message-feedback`，及其 Typert remote、API-proxy 路由权限、Cordis bundle 注册、slot-catalog 条目、命令菜单外观、包级测试与 Web 端到端覆盖。`upstream-sync.json` 将三个包记录在 `upstreamOnly` 下，使下一次上游同步不会重新引入它们。

`feedback/record`、`feedback/message-put` 与 `feedback/message-delete` 声明保留在 `SessionEventMap` 中——连同其负载类型一起从被删包迁入 `packages/core/session/src/types.ts`——因为已发布的 Session JSONL 仍携带它们。Session 格式迁移、快照归一化器与 `session-telemetry-otel` 的显式同意授权继续按原样读取并识别该词汇；这些事件是仅日志记录，无 `surfaceOp`，对派生历史无影响。

## 已考虑的替代方案

**保留休眠的反馈功能。** 否决：无人使用的生产者仍会写出用户无法处理的 sidecar 与事件，在每条消息行上保留死 UI，并在每次上游合并中重新成为冲突面。

**连事件声明一并删除。** 否决：`SessionEventMap` 成员按读时必需处理——未知类型会拒绝该日志——因此删除声明会让所有已携带反馈事件的 Session 日志无法加载，并剥夺 OpenTelemetry 上传仍遵循的同意信号。

## 后果

各用户存储根下已有的 `message_feedback.json` sidecar 保留在磁盘上，只是不再被写入或读取。历史 Session 日志照常回放、迁移与导出；已记录的显式反馈事件继续授权遥测上传。没有任何组合携带 `/feedback` 命令、点赞控件或反馈 Remote，也不再产生新的反馈数据。

## 验证

`pnpm run typecheck`（Host 与 Client 两面）与 `pnpm vitest run packages/session/session-telemetry-otel packages/test-support/session-snapshot packages/session/session-format` 覆盖保留的词汇；生成目录、文档图谱与翻译配对记录在同一变更中重新生成。
