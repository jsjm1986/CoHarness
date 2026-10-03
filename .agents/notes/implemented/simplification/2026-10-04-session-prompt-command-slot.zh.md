# Agent Note：移除 session.prompt 从未产出的 command 槽位

状态：已实现

[English](2026-10-04-session-prompt-command-slot.md) | 中文

## 问题

`session.prompt` 的公开契约描述了 handler 从未实现的斜杠命令分发：一段孤悬的 JSDoc 承诺对 `/` 开头的 prompt 走命令注册表执行，响应类型与 `sessionPromptValueSchema` 带着可选 `command` 槽位，`command-error`/`unknown-command` 占着 RPC 错误目录的条目。没有任何代码产出该槽位或这两个错误码；web UI 的命令走 `remote.commands.execute`，从不读取该槽位。这套陈旧表面对其他 API 消费方与生成目录构成误导。

## 决定

删除死表面：孤悬文档块、`prompt` 响应类型及其 schema 中的 `command` 成员、`RpcErrorMap`/`rpcErrorSchema` 里的两个错误码及其测试断言。斜杠命令行为保留在真正实现处——commands Remote 及其 `command/run`/`command/done` 事件；未匹配的 composer 行按普通用户消息提交。

## 文件

- `packages/host/apiproxy/src/api/sessions.ts` — 删除孤悬斜杠命令文档块；`prompt` 返回 `{ accepted: true }`。
- `packages/host/apiproxy/src/api/sessions.schema.ts` — `sessionPromptValueSchema` 去掉 `command` 成员。
- `packages/host/apiproxy/src/api/rpc.ts` / `rpc.schema.ts` — 错误目录移除 `command-error` 与 `unknown-command`。
- `packages/host/apiproxy/tests/rpc-schemas.spec.ts` — 删除已移除码的目录断言。

## 影响

wire 契约现在只声明 handler 实际产出的内容。今后进入该域的错误码必须在同一改动中指名活着的产生方；schema 成员必须有发射点。
