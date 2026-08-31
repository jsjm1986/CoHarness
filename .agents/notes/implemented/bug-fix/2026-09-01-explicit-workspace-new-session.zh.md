# Agent Note: 明确的 Workspace 新建会话意图

Status: implemented

[English](2026-09-01-explicit-workspace-new-session.md) | 中文

## Problem

选择 Workspace 时按设计打开最近历史，但唯一的新建入口依赖 Workspace 行悬停显示，在桌面端很难发现。Host 列表尚未跟上时，新预留的空白 Session 还可能暂时脱离目标分组，让用户误以为创建没有生效。

## Decision

保留 Workspace 选择的历史优先语义，并把“新建对话”作为独立操作。真实 Workspace 行始终显示加号，Hero 在 Workspace 选择器旁提供同一个操作。两者都调用既有的 `startSession` → `connectWorkspace` 路径：优先复用一个兼容的空白 Session，否则创建一个 reservation。

新预留的空白草稿在 Host 报告成员关系或首条可见事件到达前，列表使用仅客户端的 `workspaceId` 提示。该提示只用于分组和当前分组展开；会话进入有效状态或被移除后清掉，绝不序列化、参与搜索或写入 Workspace 成员关系。重复操作仍由既有的 Workspace single-flight 与 draft reservation 合并。

## Alternatives considered

**让选择 Workspace 直接创建空白 Session。** 否决：这会隐藏最近对话，并改变已经确定的历史优先入口语义。

**每次空白点击都持久化一个新 Session。** 否决：会积累废弃行，重复点击也会生成含义不清的会话。

**只在悬停时显示加号。** 否决：桌面端不易发现，且与移动端始终可用的入口不一致。

**允许一个 Workspace 同时存在多个空白草稿。** 否决：一个可复用 reservation 已足够，也能避免空白占位符堆积。

## Consequences

用户可以先打开 Workspace 中的历史，再从同一空间开始新对话，不需要切换模式或猜测入口。额外的分组提示只存在于客户端列表内，并在首个持久内容边界清除；它不会改变 Session wire 约定、持久化格式、Workspace 成员关系或搜索结果。既有的一份草稿复用与 single-flight 继续防止重复空白 Session。

## Verification

客户端 runtime、Workspace tree 与 ConversationRoot 测试覆盖空白草稿保留、提示分组、Hero 显式激活和首条消息后的提示清除。GUI 全套测试与 TypeScript typecheck 通过。组装 Web 历史入口场景仍验证历史优先，并覆盖桌面与紧凑布局下的显式新会话路径。

## Related

- [Workspace 进入优先打开历史会话](2026-08-26-workspace-history-first-entry.zh.md) — 历史优先选择仍是权威语义，本记录补充独立的新建意图。
- [延迟会话草稿与权威内容水位](../architecture/2026-08-26-session-draft-lifecycle-and-content-watermarks.zh.md) — 持久草稿 reservation 与可见内容提升规则保持不变。
