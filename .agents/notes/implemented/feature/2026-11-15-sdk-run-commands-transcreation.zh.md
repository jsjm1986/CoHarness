# Agent Note：SDK run-commands 在载体架构上的转译移植

Status: implemented

[English](2026-11-15-sdk-run-commands-transcreation.md) | 中文

## Problem

上游 `dsh-v0.2.2-rc.3` 发布 `sdk-run-commands`：`session/query` 把输入路由到原生命令执行或普通提示词，并以 `command/run`、`command/done`、`session.query.completed` 表达生命周期，另有 `approval/request` 与 `user-question/ask` 两个服务器到客户端请求。对齐评审曾将其延期，因为上游 SDK 服务器以 `AsyncLocalStorage` 作用域承载这一切，而本 fork 的服务器属于另一代：SDK 持有的 agent 保存在 `this.sessions`，跨包上下文是载体作用域的 `Scoped<SubagentRuntime>`，而非环境化的 async-local 状态。直接挑拣会引入第二套所有权模型；该特性必须用本地原语重新表达。

## Decision

按转译方式移植：线缆词汇与客户端可见行为保持一致，所有权内部实现不同。

- **协议**（`packages/sdk/protocol`）原样承载词汇：`session/query` 请求/结果种类、`CommandExecution`/`CommandResult`、`session.query.completed`、`approval/request` 及 `allowed-once`/`rejected`/`cancelled` 结果联合、`user-question/ask`/`user-question.cancelled`、`capabilities.userQuestions`，以及 transport 中对端请求的 `AbortSignal` 支持。
- **服务器**（`packages/sdk/server`）在本地原语上重新实现 query-content 校验、query-input 路由、query-activity 跟踪与 user-question 桥接。Agent 所有权是显式状态：存活 `this.sessions` 条目优先，再以 `ctx.subagents.rootOf(agent)` 认领受管后代；`SubagentError`/`UNAUTHORIZED` 的查找视为「不属于」，其余查找失败按关闭语义上抛。持久会话谱系（`origin: 'subagent'` 加 `parentSession`）控制 `subagent.started` 通知并提供子会话归属，替代上游的激活注册表。命令归因采用区间模型——一个活动认领最内层的开启 run——而非上游的活跃查询簿记。shutdown 保留 `initialized`，使迟到的 `session/query` 仍收到 `SDK server is shutting down` 而非未初始化错误。
- **TypeScript 客户端**把 `run()` 路由到内部 `session/query`，校验命令生命周期与完成字段，暴露 `onRequest`/`onUserQuestion`，并在 initialize 中通告 `capabilities.userQuestions`（现在 initialize 先调用 `start()`，保证先捕获处理函数再宣告能力）。上游分歧处的 fork 语义予以保留：`serializeSessionRun` 串行化同会话高层 run；客户端释放已完成谱系边，已结束子会话的后代离开根树；`close()` 后 `start()` 仍然禁止；`normalizeInput` 位于 `client.ts`。
- **Python SDK** 镜像相同路由与模型（`CommandExecution`、`ApprovalRequestParams`/`Result`、`UserQuestionRequest`/`Answer`）、`_serialize_session` 按会话加锁，以及对端请求的 `next_request`/`respond`。

## Alternatives considered

- **直接挑拣上游服务器**——否决：它会在载体模型旁再装一套 `AsyncLocalStorage` 所有权，复制会话身份，并让审批/子代理检查回答与 `ownsAgent` 不同的问题。
- **为匹配上游并发而移除 `serializeSessionRun`**——否决：同会话 run 串行化是 fork 的既定契约；上游测试改写为断言排队行为。
- **在运行时通道就绪前跳过 Python 镜像**——否决：按仓库约定两个 SDK 投影同一 loop，且假对端套件无需构建 wheel 即可运行。

## Consequences

- 两个 SDK 的 `run()` 现在原生执行已注册的斜杠命令；字面斜杠文本需走底层 prompt 路径（见 `docs/upgrade-guide/v0.2.1-rc.1.coharness.1/sdk-run-commands/`）。
- 审批与提问处理仅通过显式 opt-in 到达 SDK 调用方（`approvalRequests`、`onUserQuestion`/`on_user_question`），且 user-question 只桥接 SDK 直接持有的 agent——受管后代不桥接。
- 仅存在于上游的延期接缝已记录在对齐矩阵 `packages/sdk/server`/`client`/`protocol`、`packages/interaction/commands` 与 `non-package:python` 各行：`bindSubagentActivation` 与 manager-resident 夹具、`waitForTreeWork`（fork 保留 `waitForChildren`）、嵌套 `startActivation` parent 形状，以及无关的 scheduled-reminder `schedule/resolve-agent` 改动。

## Verification

- `npx vitest run packages/sdk/server/tests/` ——263 个测试通过（移植的 approval、commands、query-input、query-activity、user-questions 与 parity 套件，以及适配后的 server spec）。
- `npx vitest run packages/sdk/client/tests/ packages/sdk/protocol/` ——195 个测试通过，其中 `close-recovery-example.host.spec.ts` 在真实构建的运行时上执行 `session/query`。
- `python/sdk/.venv/bin/python -m pytest tests/test_run.py tests/test_approval.py tests/test_user_questions.py` ——70 个测试通过。
- `pnpm run verify-export-jsdoc`、对改动包的 `run-oxlint` 与 `git diff --check` ——干净；`pnpm run build` host 编译器通过（聚合 typecheck 因既有的、无关的错误及本机 host 聚合 OOM 失败）。
