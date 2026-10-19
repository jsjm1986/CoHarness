# Agent Note: Session-handoff 工具——有界本地投影与可选辅助模型 capsule

Status: implemented

[English](2026-10-18-session-handoff-tool.md) | 中文

## Problem

`session_search` 能定位哪个会话包含某主题，`session_event_read` 能翻页单个事件窗口，但两者都回答不了最常见的续接意图——“从那个会话停下的地方继续”。ZCode 用一个专门的 `handoff` 策略解决：读取转录尾部，并让辅助模型蒸馏出续接 capsule；我们的召回工具集没有等价物。

## Decision

handoff.ts 新增第六个模型可见工具 `session_handoff`，复用现有五个工具的授权与超时路径。本地投影对已授权会话的当前界面做一次读取，保留直接的用户与 assistant 对话以及压缩检查点，丢弃工具调用、推理、注入上下文和其他界面，再在 `handoffChars` 预算内按最新优先截取尾部，使简报始终从最新状态开始。

当 `llm` 服务与路由目标都能解析且 `handoffExtraction` 开启时，`handoffExtractChars` 以内的序列化对话发送给单个 `session-handoff` 辅助请求，提示词要求输出目标、决策、文件、状态与下一步。所有失败形态——提取关闭、界面超限、服务缺失、capsule 为空、请求失败——都回退到有界本地尾部，工具不依赖辅助路径。`handoffTimeoutMs` 覆盖投影与提取之和；目标会话 id 与其他操作一样在读取后重新校验。

## Consequences

- standard 预设多一个模型可见工具：每次模型请求增加一个 schema 和一条调用卡片呈现路径。
- 挂载 `llm` 服务且路由目标可解析的会话，每次调用多一次 `session-handoff` 辅助请求；两者缺席的部署仍以零模型成本返回有界本地尾部。
- 简报是已授权会话当前界面的投影，继承该界面的排除规则——shadowed 与 log-only 事件永不进入模型视野。

## Alternatives considered

**ZCode 的分块 map-reduce 提取。** ZCode 把长转录切成至多五段，逐段提取后再跑第二趟综合。该设计的目的是在没有索引的情况下消化数 MB 转录；我们的界面投影已被 `handoffChars` 限界，单次提取即可覆盖现实输入。分块方案会多一次模型调用并引入合并失败形态，而输入本就被预算封顶。

**在 `session_event_read` 上加 `handoff` 策略开关。** 续接简报需要界面投影与不同的输出格式，而不是原始事件上的另一种窗口；独立工具让两个 schema 都保持小，也让调用卡片能表达意图。

## Verification

`tool-session-query` 测试覆盖本地尾部排序与截断、检查点保留、跳过的事件类别、带请求头路由的辅助提取、提取关闭、空界面与超限界面、提取失败回退、目标重校验拒绝、调用方自身目标、未授权目标拒绝、配置校验、取消以及工具调用卡片呈现。包测试 124 项全过，新源码 100% 覆盖；`docs/tool-catalog` 重新生成第六个工具，`verify-cordis-config` 接受该组合。
