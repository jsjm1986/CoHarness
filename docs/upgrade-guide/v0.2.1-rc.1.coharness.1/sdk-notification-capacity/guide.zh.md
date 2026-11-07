---
kind: upgrade-guide
description: "SDK 谱系容量独立于通知队列容量，超限时明确终止交付。"
---

# 配置 SDK 通知与谱系容量

[English](guide.md) | 中文

## 变更

TypeScript 和 Python SDK 独立于通知队列容量保留活跃 subagent 谱系，默认谱系上限为 10000。超限时以 `TransportClosedError` 终止通知交付，不再静默淘汰活跃祖先。过滤器关闭自身订阅后，当前通知不会交付给该订阅。

## 迁移

1. 根据各消费者排队通知的数量配置 `maxNotificationQueue`（TypeScript）或 `max_notification_queue`（Python）。
2. 预计同时存在超过 10000 条活跃父子关系时，设置 `maxSessionRelationships`（TypeScript）或 `max_session_relationships`（Python）。配置值必须为正整数。
3. 收到关系超限错误时关闭客户端，以足够容量创建新客户端，不通过谱系不完整的失败客户端重试。
4. 验证消费者持续取出通知时，根会话订阅能收到子会话和孙会话通知；过滤器关闭自身订阅后不再收到帧。
