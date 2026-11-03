---
kind: upgrade-guide
description: "新会话准备期间保护来源输入框，防止向旧对话发送消息。"
---

# 新会话准备期间保持输入归属

[English](guide.md) | 中文

## 变化

新会话准备期间暂时锁定来源输入框，并显示“正在打开新对话…”。草稿和运行任务保留，停止操作仍可使用。准备成功后打开新 Session，失败后恢复原对话的输入。其他面板和浏览器标签页保留各自的输入。

## 迁移

自定义 `ISessions` 和 `SessionsPort` 实现须接受 `beginNavigation({ blockInputFor: sessionId })`，在 Session 列表投影中发布可选的 `navigationBlockedSessionId`，并实现 `finishNavigation(signal)`。完成操作只解除原始信号拥有的锁定。导航消费方在 `finally` 中结束自己的意图；同步选择或新意图会取代旧锁定。省略 `blockInputFor` 时不锁定输入。

重新构建自定义客户端组合并刷新页面。无需数据库或 Session 日志迁移。详见[客户端导航参考](../../../../packages/client/runtime/README.zh.md)。
