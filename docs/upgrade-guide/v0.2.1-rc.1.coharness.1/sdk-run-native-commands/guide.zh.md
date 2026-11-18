---
kind: upgrade-guide
description: "SDK run() 将以斜杠开头的输入路由到原生命令，而不再作为字面提示词发送。"
---

# SDK run() 将斜杠输入路由到原生命令

[English](guide.md) | 中文

## 变更

TypeScript 与 Python SDK 的 `DeepSeekHarness.run()` 与 `Session.run()` 现在通过 `session/query` 发送输入。首个内容块以已注册命令开头的文本会原生执行该命令并返回其结果；其余文本与内容块保持原有提示词行为。先前传入 `/compact` 等形似命令字符串的调用方，现在得到的是命令 `RunResult`（其 `finish_reason`/`finishReason` 为 `completed` 或 `error`），而不再是一个模型回合。

底层 `prompt()`/`session_prompt()` 仍然提交字面文本，包括斜杠前缀。新增的可选接口：`approvalRequests` 把 `approval/request` 决策暴露给客户端；`onUserQuestion`/`on_user_question` 回答 `user-question/ask` 批次。对端新增 `command/run`、`command/done` 与 `session.query.completed` 通知；一次运行在该通知处结束，而非会话空闲处。

## 迁移

1. 检查所有把用户可控或以斜杠开头的字符串传给 `run()` 的调用点。如需保留斜杠字符串的字面含义，改用底层 prompt 方法，或经由其他入口以普通回合发送。
2. 如需接收运行时批准决策，在 initialize 时传 `approvalRequests: true` 并安装 `onRequest`（TypeScript），或读取 `next_request()`/`respond()`（Python）。如需回答运行时提问，在 `initialize` 前安装 user-question 处理函数。
3. 更新原本等待命令后 `session.status` idle 的等待方：改为在 `session.query.completed` 或返回的 `RunResult` 处结算。逐一在升级后的运行时上执行受影响的调用并核对结果种类以确认迁移完成。
