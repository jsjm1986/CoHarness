---
kind: upgrade-guide
description: "send_message 工具参数 `agent_id` 更名为 `agent`,按树内位置命名智能体。"
---

# `send_message` 按名称寻址智能体

[English](guide.md) | 中文

## 变更

`send_message` 工具的目标参数由 `agent_id`(不透明的品牌化会话标识)改为 `agent`——即 `list_agents` 在调用方子代理树中报告的目标智能体名称。任何直接驱动模型面工具面的集成(录制的会话夹具、脚本化工具调用、协议回放)若仍传 `agent_id` 会被判为未知参数而拒绝;已存储的标识符也不再可解析,因为名称是树相对的而非全局的。

## 迁移

1. 在构造 `send_message` 调用的回放脚本、夹具与协议客户端中,将参数 `agent_id` 改名为 `agent`,并传入 `list_agents` 报告的智能体名称(如 `"reviewer"`)。
2. 持有历史会话标识符的集成改为经会话树(`list_agents`、`session_event_read`)解析,不再回传给工具。
3. 确认调用生效:工具结果为 `message delivered to agent <name>`,目标会话收件箱出现新消息。
