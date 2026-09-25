# Agent Note: 外部运行时持续成员共用同一个 adapter turn

状态：已实现

[English](2026-09-25-external-runtime-continuable-members.md) | 中文

## 问题

Agent Teams 经 `ctx.subagents.startContinuable` 生成队友，roster 按名选择 provider。此前只有进程内 `spawn`/`fork` provider 声明 `prepareContinuable`；外部 provider——[产品后端决策](../feature/2026-08-04-claude-code-and-codex-subagent-backends.zh.md) 的 `subagent-claude-code`、`subagent-codex` 与 [ACP 后端决策](../feature/2026-06-22-acp-subagent-backend.zh.md) 的 `subagent-acp`——只接受一次性 `start()` 调用，所以配置为使用它们的 Team 根本无法创建成员。让每个 provider 各自实现持续生命周期会在每个 provider 内重复耐用身份、inbox 排序、activation、冷恢复与处置，而它们的外部运行时都不暴露 harness 能拥有的 Agent 句柄。

## 决定

外部持续成员是普通的进程内 continuation 管理子 Agent；外部运行时只充当其模型后端。provider 通过实现 `prepareContinuable` 标记能力（仅 detached 数据——Agent、句柄、prompt 递送函数都不越过边界），注册 `LlmAdapter` 路由，并声明 `agentRouteDefaults`，使未显式携带 `agentOptions` 的 Team 请求仍能解析出有效的 provider/model。成员的每次模型调用经 `GenerateOptions.sessionId` 映射到外部运行时耐用会话上的一个 turn，以子体 harness Session id 为键：

- `subagent-claude-code`：每次调用一个 Agent SDK `query`，带 `persistSession`，已绑定时 `resume`；挂载 `llm` 服务即具备成员能力。
- `subagent-codex`：每次调用一个 `codex app-server --stdio`；`thread/start` 带 `ephemeral: false` 铸造耐用线程，`thread/resume` 重新挂载。
- `subagent-acp`：每次调用一个 ACP 子进程；`session/load` 挂载耐用会话。`session/load` 是可选 ACP 能力，故 `resume: true` 是配置门，provider 在成员创建时探测 `loadSession`——只支持一次性的 agent 在耐用子体诞生前即被拒绝。

共享成员机制集中在 `dsh-subagent/external` 而非各 provider 一份拷贝：仅追加的 JSONL 绑定存储（子会话 ↔ 外部会话、待决 prompt、已消费游标）、模型可见消息列表上的尾随用户 prompt 窗口、以及 `externalMemberTurn`——所有 adapter 委托的单一 turn 驱动器。已发出的 prompt 记录为待决；恢复时用外部运行时自己的耐用 transcript 证明其状态——已完结的答案直接重放不重发，可证未送达的 prompt 重发一次，不可证的结果以 `EXTERNAL_TURN_OUTCOME_UNKNOWN` 丢弃而不冒重复递送的风险。没有 `prepareContinuable` 的 provider 保持一次性能力，`startContinuable` 以 `UNSUPPORTED_CAPABILITY` 拒绝。

## 已考虑的替代方案

**让每个 provider 拥有完整 continuable 生命周期。** continuation manager 将不得不把身份、inbox、持久化、activation 与重启下放给三个各自为政的实现，未知结果/不重发规则也要在每个 provider 重复推导而无共享证明。

**把外部运行时暴露为远程 Agent。** Claude SDK 会话、Codex 线程和 ACP 会话都不提供 Activation 机制可安装的 Agent 表面；造一个 facade 会把同一子体的所有权割裂到两个生命周期。

**自动重试未知结果的 turn。** 外部 transcript 并不总能证明 prompt 是否被消费；重发可能在耐用外部会话内重复用户 turn，因此成员改为上报未知结果，已消费游标照常推进。

## 后果

Team 成员保留全部 harness 侧保证——耐用身份、有序 inbox、Activation、冷恢复、处置——而其模型调用在外部产品的耐用会话内执行。成员的每次模型调用承担一次外部进程 spawn 与握手开销；不做连接池让每个调用的所有权保持独立，拆卸仍是 subprocess 缝的职责。辅助模型调用（compaction、标题、评审）在成员路由上被拒绝，因为外部会话无法应答——触发此类调用的成员响亮失败，而不是静默地寻址到错误的会话。崩溃恢复完全依赖外部运行时自身的耐用 transcript：JSONL 绑定存储只记录映射与待决 prompt，从不重放对话内容。没有 `llm` 服务（Claude Code、Codex）或未在具备 `loadSession` 能力的 ACP agent 上设置 `resume: true` 的部署中，provider 保持仅一次性能力，`startContinuable` 返回 `UNSUPPORTED_CAPABILITY`，而不是产生一个半能力的成员。
