---
description: "ctx.agentTeams 之上的 Agent Teams 模式选择、投影与共享任务板"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-agent-team

[English](README.md) | 中文

Agent Teams 协调域。`ctx.agentTeams` 持有每个根 Session 的 Team 模式选择，以及一块从 Lead Session 日志折叠而来的共享、带修订校验的任务板。teammate 是普通的命名可延续 subagent——持久目录名、同级唯一、根相对路径——因此创建、消息、恢复与中断全部归标准 `ctx.subagents` 能力面。[Agent Teams v2 迁移 note](../../../.agents/notes/implemented/architecture/2026-11-15-agent-teams-v2-migration.zh.md) 持有事件版本与迁移决策。

## Summary

`dsh-experimental-agent-team` 在 Team 模式开启时把单个编码会话变成一个小型工作团队：根 agent 成为 Lead，向命名 teammate subagent 委派工作，并通过一块带 compare-and-set 更新的持久任务板协调共享工作。Team 状态存在 `agentTeam` Session 投影中——模式选择与任务快照从 Lead 日志确定性重放，上一代 roster/mailbox 写入的 version-1 记录保持可读。本包自身不提供工具——模型面任务工具请挂载 `dsh-experimental-tool-agent-team`,teammate 消息请挂载 `dsh-tool-subagent-control`。需要持久 Session 存储才会激活。

## Table of Contents

- [Config](#config)
- [Team mode](#team-mode)
- [Members and names](#members-and-names)
- [Shared task board](#shared-task-board)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="config"></a>
## Config

```yaml
- id: agent-team
  name: '@deepseek-ai/dsh-experimental-agent-team'
  config:
    maxTasks: 256
    defaultEnabled: false
```

`maxTasks` 约束每个根的非删除任务数，必须为正 safe integer。`defaultEnabled` 为不携带先前 `team/mode` 记录的新启动根 Session 选定 Team 模式；已存 Session 保持其日志所选。roster/mailbox 代的配置键已退役并在加载时显式报错——teammate 上限、收件箱投递与生命周期现归 subagent 能力面。

服务依赖 Agent、Session、Session 持久化、Session 投影与 subagent 服务。缺少持久 Session 存储的组合不会激活它。

<a id="team-mode"></a>
## Team mode

Team 模式是逐根的持久选择，而非插件存在性。`agentTeams.setEnabled()` 是仅 root 可用的 Remote，负责追加 `team/mode`;选择在持久化完成前生效并作用于调用方整棵 subagent 树。任务工具与 Team 提示词节在每一步准备时解析可用性，因此会话中启停会改变模型的下一回合而不需重启子级或删除任务。重复同一选择只 flush，不产生重复事件。

<a id="members-and-names"></a>
## Members and names

teammate 是根的 subagent 树中一个命名的可延续后代。名称遵循持久目录规则——小写、同级唯一、可按根相对路径寻址——`list_agents` 渲染 Team 所见的树。任务归属同时记录成员的 Session id 与其提交名称，因此视图跨恢复保持稳定。来自其他根的 Team 事件在本投影中是惰性的：成为自己运行时根的 fork 会开启自己的任务板而非继承父级。

<a id="shared-task-board"></a>
## Shared task board

任务是追加为 `team/task` 记录的完整版本化快照。每次变更携带 `expectedRevision`;陈旧调用方收到 `TEAM_TASK_STALE_REVISION` 而不会覆盖更新值。任何成员可创建无主 pending 任务；就绪的无主任务由成员 claim，只有 root 能把 owner reassign 给自己或其他可延续后代。数字 `task-<n>` id 要求 safe-integer 后缀。

依赖必须指向现存未删除任务并构成完整 DAG，不允许自引用或重复边；pending 任务仅在全部阻塞项完成后才就绪。删除带有存活依赖方的任务会被拒绝；已删任务保留为墓碑供重放，但不占 `maxTasks` 额度且不出现在列表中。`writeScopes` 是归一化的工作区相对前缀，与进行中任务重叠时给出告警——协调提示而非文件锁。

<a id="model-experience"></a>
## Model Experience

### Team state

#### What the model sees

没有直接可见项：模式选择与任务快照是仅记日志的记录。模型见面是 `dsh-experimental-tool-agent-team` 的四个任务工具与策略节，外加用于 teammate 的标准 subagent 工具。

#### Token effect

无模型 token；持久记录留在派生历史之外。

#### KV Cache effect

无。

## Known Limitations and Deferred Work

- **单进程与单一共享检出**——成员共享 cwd 并即时看到彼此编辑；本包不提供 worktree、远程成员、合并或文件锁。
- **写范围仅为建议**——Bash、格式化工具、代码生成器与直接外部写入可绕过文件系统版本检查；Lead 必须协调归属并评审最终 diff。
- **无自动归属释放**——不活跃、中断、进程退出与失败的工作都不会释放任务 owner。
- **无 Team 等待原语**——等待就是普通的 subagent 投递：结算通知与 `send_message`，而非任务板边沿。

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
