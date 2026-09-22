# Agent Note：real-API e2e 漂移修复（Messages 端点、挂载顺序、上游契约回填）

Status: implemented

[English](2026-09-22-real-api-e2e-drift-repairs.md) | 中文

## 问题

必跑的 `test:e2e` 泳道暴露出一大片失败，可归并为少数几处漂移：

- 所有 `messages` 协议请求均 404：`resolveAdapterOptions` 把服务根形式的 `DEEPSEEK_BASE_URL`（`https://api.deepseek.com`、`/v1` 或 `/anthropic`）映射为 `{base}/v1/messages`，而公开 Messages API 位于 `https://api.deepseek.com/anthropic/v1/messages`。全部 real-model e2e 失败——headless 的 coding/resume/compaction/full-loop/todo-write/real-model、fs-tools、spawn-in-process、subagent-acp、ACP escalation/hooks、agent-instructions、request-cache、session-title provider、pi-ai block 对齐测试（其 `fromDeepSeek` 一侧返回零 block）——共用此根因。
- `AgentLoop.startConfigured` 仅在配置 agent 携带显式 `sessionId` 时才等待挂起的持久化后端；无 `sessionId` 的 `agents:` 条目在创建时同步读取 `ctx.sessionPersistence`。四个 cordis.yml 组合把 `session-persistence-jsonl` 挂在 agent-spine 之后，会话静默变为临时会话。
- otel loader-composition 套件仍断言已移除的 `FULL` 模式与旧的 `load()` 侧中断尾部修复；crash-recovery 测试被简化掉了 `interruptedTurnClosers`；jsonrpc keyless smoke 对现已发布 `messages` 协议的组合发送 chat-completions SSE；`sdk` profile 从 `dsh-base` 继承了 fork 新增的默认 `tool-str-replace-editor`，与其文档化的 opt-in 契约相矛盾；Python SDK 指南缺少 keyless smoke 读取 patch 块所需的 `opt-in-to-str_replace_editor` 锚点。

## 决策

- `messagesServiceBase` 现在把所有公开服务根形式规范化为 `…/anthropic`，再由 `messagesApiRoot` 追加 `/v1/messages`；自定义网关 base 保持原有 `/v1/messages` 路由。`DEEPSEEK_BASE_URL` 在各处仍表示服务根（临时把工作流改成 `/anthropic` 的改动已还原）。
- 在 `session-telemetry-otel.cordis.yml`、`minimal.cordis.yml`、`child.cordis.yml`、`time-context.cordis.yml` 中把 `session-persistence-jsonl`（及其 checkpoint-policy 跟随项）移到 agent-spine 之前，与发布的 headless profile 已携带的约定注释一致。
- 对 fork 漂移处逐字回填上游契约：telemetry fixture 默认改为 `FEEDBACK_ONLY`，并在第二个私有 turn 前记录 feedback；e2e 断言 feedback 授权前缀的导出形态与新的 DISABLED 警告文案，并断言 `FULL` 被拒绝；`crash-recovery` 通过 open/read 句柄读取并追加 `interruptedTurnClosers`，期望事件列表包含 `system/message`；jsonrpc smoke 的假服务器发送 `stop_reason: 'max_tokens'` 的 Anthropic SSE，并断言 messages 格式的请求字段以及 `startup failed: 1 required plugin did not activate` 诊断。
- `sdk-app` 的 patch 禁用 `tool-str-replace-editor`，恢复文档化的 read/write/edit 默认；Python SDK 指南新增带锚点的 opt-in 小节，其 yaml 为 `sdk-minimal` 插入 `fs-local` 与编辑器，为 `sdk` 仅插入编辑器一行。
- `fs-local` 的展示路径解析保留 `..` 段的物理拼写（最近已存在祖先的 `realpath` 回溯），经由符号链接的 session root 向上遍历时落在物理父目录上。

## 已考虑的替代方案

**在 CI 中把 `DEEPSEEK_BASE_URL` 钉为 `/anthropic`。** 否决：fork 在文档、测试与 chat-completions 路由中统一把该变量当作服务根；在 resolver 内部重映射保持单一语义。

**把 `awaitStartupPersistence` 扩展到无 `sessionId` 的配置 agent。** 本次修复中否决：上游携带相同的非对称读取，发布的组合注释已文档化挂载顺序要求，且在没有驱动消费者的情况下扩大产品等待会与上游分叉。

## 影响

- 修复簇中的全部 keyless 套件本地通过：otel loader-composition 4/4、crash-recovery 2/2、jsonrpc keyless-smoke 4/4、sdk keyless-smoke 9/9、multi-project-sandbox 4/4、time-context 1/1。
- real-model 套件本地仍受凭据限制，并共用一个 CI 验证假设：所有已观察到的失败形态（空 `finalText`、零 `tool/call`、`stopReason 'error'`、`acceptedThrough -1`）均与 Messages 404 一致，应在重映射下清除。
- 相关：[挂载竞态笔记](2026-09-21-configured-agent-persistence-mount-race.zh.md)负责 `sessionId` 配置等待，本约定与之互补。
