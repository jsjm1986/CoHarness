# goal/：持久化的同会话目标

[English](README.md) | 中文

agent 会话的持久目标状态，独立于消费它的面向模型工具与续行策略。goal 状态是所属会话日志的一部分；消费方依赖 `dsh-goal`，绝不依赖具体的 agent loop（智能体循环）。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`goal/`](goal/README.zh.md) | 目标状态与生命周期 | `ctx.goals` |
| [`goal-round-driver/`](goal-round-driver/README.zh.md) | 同会话目标续行 | 无 |
| [`tool-goal/`](tool-goal/README.zh.md) | 面向模型的目标工具 | 无 |
| [`command-goal/`](command-goal/README.zh.md) | 面向用户的目标命令 | 无 |

子系统参考——goal 标识、生命周期快照、激活、变更记录——见 [docs/subsystems/goal.md](../../docs/subsystems/goal.zh.md)。


## 概述

goal 组让一个 agent（智能体）会话在重启、恢复和 fork 后继续追求一个持久的完成目标。agent 可以创建和更新该目标，用户也可以用 `/goal` 直接检查或控制它，而不消耗模型轮次。可选的续行包可以让进行中的工作连续执行多个 Round。每个会话只有一个当前目标，该目标记录完成状态而不调度工作；因此，自动续行必须单独启用。
