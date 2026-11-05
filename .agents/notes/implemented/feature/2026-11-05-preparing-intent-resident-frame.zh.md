# Agent Note: 准备中的意图挂载常驻会话框架

Status: implemented

[English](2026-11-05-preparing-intent-resident-frame.md) | 中文

## Problem

`ConversationIntents.begin()` 在获取所选 Session 期间展示可编辑草稿，但它原先渲染的是一张漂浮在空白页面上的裸 textarea 卡片：没有会话框架、没有 composer 设施，Session 落地时还有明显的布局跳动。该机制是提升感知速度的特性，但当时的呈现看起来像坏掉的页面。

## Decision

`ConversationRoot` 为活动意图挂载常驻 `conversation.content` 工厂，并通过 `ConversationContentInputProps` 上新增的可选 `pendingIntent`/`onIntentInput`/`onIntentRetry`/`onIntentHide` owner props 传入意图。`pendingIntent` 存在时，`ConversationContent` 解析为 active（停靠）相位，抑制会话 header 插槽、transcript 视图、`data-conversation-session` 标记、session 作用域的 `conversation.composer` 接管链和全部 `conversation.composer.bar` 渲染——环境已提交的 Session 无法泄漏进准备中界面。composer 座位改为渲染 `PendingIntentComposer`：一张镜像 InputBar 外观（22px 圆角、input-major 填充、soft 海拔、16/16/12 内边距、14/20 文本）的草稿卡片，经 `intents.edit` 编辑 `intent.text`，使真实 composer 在 `transfer()` 时落入同一座位而无布局跳动。它不拥有发送动作，因为提交需要已获取的 Session。Workbench 面板通过 `solo` 呈现方式渲染同款独立卡片。

## Alternatives considered

**把临时 sessionId 绑定到真实 `inputHub` shell。** Bar 会完全可用，但草稿会活在伪 session shell 里，而 `transfer()` 只搬移 `intent.text`；shell→intent 的镜像订阅为一个短暂界面引入了第二个事实来源。

**渲染无会话的 `conversation.composer.bar`。** session-maybe 的 bar 在没有 Session 时是惰性态——禁用的 textarea 无法承载该特性赖以存在的抢先输入草稿。

## Consequences

准备态复用了常驻框架、token 与 composer 几何，没有引入平行视觉体系。卡片为 preparing/unavailable/denied 文案保留 `role="status"` 以及重试/返回动作。会话专属控件（附件、plan/model 座位、dock、接管面板）保持缺席，因为 pending 路径从不挂载 session 作用域插槽。覆盖位于 `tests/skeleton.client.spec.tsx`：pending 框架不发起任何 session 插槽调用，textarea 编辑调用 `onIntentInput`，unavailable/denied 态暴露重试与返回。
