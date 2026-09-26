# @deepseek-ai/dsh-experimental-tool-agent-team

[English](README.md) | 中文

[`ctx.agentTeams`](../agent-team/README.zh.md) 的 scoped 模型适配器。它会在每个隐式 Lead 与持久 teammate scope 中安装 Agent Teams 策略和协作工具。scoped Team 定义会覆盖同名的旧全局 continuable-subagent control，因此同时挂载两者的组合必须禁用旧定义。

## 概述

本包让模型创建具名 teammate、向它们发送消息、查看可用状态、等待进展、中断卡住的工作，并通过共享任务板协调。每个团队成员都会获得相同的九个工具，以及在共享工作区协调的指引。当模型只应在你明确要求后运行团队时，选择本包。它会取代同名的旧版 subagent 控件，因此同时需要两者的组合必须禁用旧定义。本包以实验性名称公开发布，但不提供稳定性保证。

## 配置

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
  config:
    freshProvider: spawn
    forkProvider: fork
```

`freshProvider` 与 `forkProvider` 选择已注册的 continuable-subagent provider。任何声明 `prepareContinuable` 的提供方都可用，包括外部运行时提供方：`llm` 服务挂载时的 `subagent-claude-code` 与 `subagent-codex`，以及设置 `resume: true` 的 `subagent-acp`——它们把耐用 Team 成员保留为进程内子级，同时把模型调用路由到各自外部运行时的可续接会话。不具备该能力的提供方会以 `UNSUPPORTED_CAPABILITY` 拒绝 spawn。固定模型策略仅在用户明确要求 Agent Teams 或 teammate 时创建 teammate。

## 工具与权限

生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-agent-team)负责精确 schema。该适配器提供 teammate 创建；quiet 与 waking peer 投递；roster 列表、等待和仅限 Lead 的 interrupt；以及任务 create／list／get／CAS update 操作。

每个工具都要求完全相同的调用 `Agent`。`spawn_teammate` 与 `interrupt_agent` 在 `ctx.agentTeams` 内部强制执行 Lead 权限，而不只依赖描述。所有成员都可以与任意 peer 通讯并使用任务板。任务变更保留领域层的 Owner／Lead 与 revision 校验。

`send_message` 在 mail 持久化后即成功，并且绝不会唤醒 inactive target。`followup_task` 还会让该消息成为 target 的下一个 turn，并可冷恢复 target。`queued` 结果表示持久工作已经接受，不能重试。任务 ready 不会启动 owner。`wait_agent` 在注册 10,000 到 3,600,000 毫秒的边等待前，会检查是否有另一个 running 或 provisioning member；如果没有，它会立即返回 `noProgress`，提示重新 list 并使用 `followup_task`。否则它会等待调用后发生的一条 Team 边，默认 30,000 毫秒；由于不会回放更早的变化，调用方需要在唤醒或超时后重新 list。

插件监听 Agent publication，并通过对应 Agent scope 安装注册。因此，fresh 创建与 cold resume 都会在第一次模型请求前获得相同工具／提示词集合。Agent dispose 和插件 HMR 会移除全部 scoped 注册；重新加载插件会为仍 live 的每个成员安装一套新注册，而不改变 continuation Activation。

## 不变量

**运行时不变量：** 未发布配套入口。适配器把工具与策略注册安装进团队作用域；团队定义与生命周期由 `ctx.agentTeams` 拥有。

## 模型体验

### Team 策略与工具

#### 模型看到什么

一段共享 system 策略会说明显式 delegation 要求、共享 cwd 行为、文件陈旧版本恢复、Bash／formatter／codegen 风险、task／write-scope 协调、Steer 投递、mailbox 不重试规则，以及 Lead 必须在回答前等待。Lead 与 teammate 的全部九个 Team schema 相同；执行时检查仅限 Lead 的操作权限。`spawn_teammate` 在初始 user 消息前加上 `<system-reminder>\nYou are teammate "<name>".\n</system-reminder>`，接着是一个空行和任务。该前缀不含 Team id，禁用运行时上下文时也能生效。fork 继承历史，不额外添加 Lead 身份消息。

#### Token 影响

每次 Team member 请求都有固定策略与 schema 成本。初始身份文本随普通历史经历后续步骤、冷恢复和压缩；插件不扫描或重新插入它。工具调用会增加紧凑 JSON roster、task、wait 或 receipt 结果。Peer 内容由 Team 领域保留在 target 历史中。

#### KV Cache 影响

provider／model、共享 system 策略和工具 schema 相同时，fork 保留父请求前缀并追加带身份前缀的初始任务。工具结果与 peer 消息追加在可复用请求前缀之后。原先在 system prompt 中记录身份的 Session，首次使用此布局请求时可能改变该前缀；提供方实际缓存命中仍为尽力而为。

<a id="known-limitations-and-deferred-work"></a>

## 已知限制与暂缓事项

- **提示词策略只负责协调，不负责 confinement**：它无法阻止 Bash 或外部进程写入重叠文件。
- **不会自主创建 Team**：除非用户明确要求 delegation，普通任务不会触发组队。
- **没有 Web 控制功能**：浏览器 roster 与任务板呈现不属于该 runtime 包。
