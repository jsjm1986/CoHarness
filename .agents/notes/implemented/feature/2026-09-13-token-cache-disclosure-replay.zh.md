# Agent Note：Token 与缓存展示跟随紧凑重试 settlement

状态：已实现

[English](2026-09-13-token-cache-disclosure-replay.md) | 中文

## 问题

CoHarness 已在流式 `assistant/chunk` 事件中持久化提供方用量，并在 Web 对话中提供单轮展示。Session format v2 还允许紧凑的 `assistant/attempt` settlement 携带该流。投影和展示折叠没有从该 settlement 读取用量或首 token 时间，同一步重试还可能用后一个样本替换前一个样本，而不是累计两个计费 attempt。

## 决策

Token-meter 从流式 chunk 或紧凑 Assistant settlement 中读取最后一条 `usage` 记录。`llm/retry-started` 会清除单个进行中的替换槽，因此下一次样本作为新的 attempt 累加，同时同一 attempt 的重复最终样本仍只替换自身。投影 state version 递增，通过既有机制安全使旧检查点失效；总量和 wire 字段保持不变。

Session stats 从紧凑 attempt 记录读取首 token 时间；当没有实时 chunk 提供该信息时，也从 assistant 消息的嵌入流读取。现有 CoHarness `assistant/chunk` 日志继续走快速路径，读取统计不会为了展示而物化紧凑流。完成轮次节点同时匹配 `step/start` 与 `assistant/attempt`，因此回放后紧凑 settlement 仍会进入单轮用量面板使用的轮次证据。

## 结果

已完成轮次继续展示准确的 token、缓存读取、缓存写入、输出和缓存命中率。报告用量的失败 attempt 会保留在会话总量中，重试链也不再少算提供方计费。缺失或矛盾的提供方字段仍会使单轮展示安全地不显示；提供方没有报告缓存 bucket 时不会伪造数据。在持久数据迁移路径建立期间，缺少规范化路由的旧版或格式异常 assistant envelope 不会再让读取抛出异常；准确用量仍可用，但会省略路由归因。

此变更保留既有 SessionEvent 词汇、Gateway wire 字段、ACL 行为和 UI 组合，只扩展读取路径，并通过标准 `stateVersion` 机制使旧投影检查点失效。

## 备选方案

**继续只读取 `assistant/chunk`。** 这样会遗漏紧凑 settlement 中的用量和首 token 信息，并使重试总量容易被替换而不是累计。

**把整个 token 投影替换成无界的 attempt 列表。** 现有有界总量和单槽替换规则能保留内存上限；在重试时清空该槽即可区分 attempt，无需保留完整历史。

## 验证

投影、紧凑流、重试、session-stats 和 Web UI 定向测试通过。发布版本前仍需完成 `dsh-token-meter`、`dsh-session-stats` 的类型检查、客户端类型检查和生产构建。真实提供方的缓存回报取决于部署，必须用提供方实际响应核验；回放 fixture 使用确定性的用量值。
