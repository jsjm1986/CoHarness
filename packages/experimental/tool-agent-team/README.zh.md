---
description: "Agent Teams 模式下的条件共享任务工具与策略"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-agent-team

[English](README.md) | 中文

[`ctx.agentTeams`](../agent-team/README.zh.md) 的模型面适配器。它只注册四个共享任务工具外加一节系统提示词策略，每项都以调用方根 Session 开启 Team 模式为条件。teammate 的创建、发现、消息与中断仍归标准 subagent 工具（`subagent`、`subagent_fork`、`list_agents`、`send_message`、`interrupt_agent`）；本包刻意不提供任何 Team 专用协作面。

## Summary

本包让模型通过一块共享的、带修订校验的任务板协调委派工作：创建带依赖与建议写范围的任务，列出与读取板面，并应用 compare-and-set 转移——claim、release、edit、set_dependencies、complete、reopen、reassign 与 delete。工具仅在根 Session 开启 Team 模式时存在，因此同一组合可同时服务普通会话与 Team 会话而不互相泄漏任务工具。本包以实验名称发布，不提供稳定性保证。

## Table of Contents

- [Config](#config)
- [Tools and authority](#tools-and-authority)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="config"></a>
## Config

```yaml
- id: tool-agent-team
  name: '@deepseek-ai/dsh-experimental-tool-agent-team'
```

本插件不接受配置。已退役的 `interrupt`、`freshProvider` 与 `forkProvider` 键会在加载时显式报错；teammate 请经 `subagent` 工具提供方创建，中断请使用 `interrupt_agent`。

<a id="tools-and-authority"></a>
## Tools and authority

生成的[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-agent-team)拥有精确 schema。适配器提供 `team_task_create`、`team_task_list`、`team_task_get` 与 `team_task_update`；每项注册都以 `ctx.agentTeams.isEnabled(caller)` 为条件，因此工具发现与策略节只在 Team 会话中出现。

`team_task_update` 是 compare-and-set：`expected_revision` 必须与板面当前修订一致，否则调用以 `TEAM_TASK_STALE_REVISION` 失败——并发成员以此避免互相覆盖。`owner` 参数是经 `ctx.subagents.resolveName` 解析的 agent 名称——`subagent` 返回、`list_agents` 展示的持久名称，含根相对路径。reassign 仅 root 可用；root 可指定自己或任何可延续后代。其他成员只能 claim 就绪的无主任务并管理自己拥有的任务。任务结果会把内部 owner Session id 替换为成员的 agent 名称。

就绪、阻塞与 `writeScopeWarnings` 是建议性协调：`write_scopes` 为评审记录意图而非文件锁。任务变化不会投递消息或唤醒空闲 agent——需要其他成员行动时请使用 `send_message`。

<a id="model-experience"></a>
## Model Experience

### Team policy and tools

#### What the model sees

开启 Team 模式时，一节共享策略说明共享工作目录、写范围与依赖协调、claim-update-complete 工作流，以及任务变化不会唤醒任何成员——Lead 必须在最终答复前等待所需 teammate。未开启的会话看不到该节与这些工具。任务结果以紧凑 JSON 行返回；板面本身仅记入日志，不进入派生历史。

#### Token effect

策略节与四个 schema 在每次 Team 模式请求上消耗 token；其他会话零成本。工具调用只增加小型 JSON 结果。

#### KV Cache effect

开启 Team 模式会把策略节与 schema 插入系统前缀，因此会话的首次 Team 模式请求会重建提供方前缀；同模式下的后续请求复用该前缀。同模式的 teammate 会话共享完全相同的前缀。

## Known Limitations and Deferred Work

- **写范围仅为建议**——Bash、格式化工具、代码生成器与外部进程可绕过重叠告警；Lead 必须评审最终 diff。
- **无 Team 自有等待原语**——Lead 依赖 `send_message` 回执与结算通知等待；任务变化不会中断或唤醒任何成员。
- **reassign 仅 root**——teammate 不能把自己的任务转给同伴，只能 release 供重新 claim。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
