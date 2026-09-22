# todo/：todo／规划能力家族

[English](README.md) | 中文

面向模型的 todo 能力。它是单一**产品**包，因为一个 agent（智能体）会话拥有该列表；不存在可替换的提供方约定。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`tool-todo/`](tool-todo/README.zh.md) | 存储并公开会话的 todo 列表。 | （注册到 `ctx.tools`） |

子级 README 负责工具、持久化和渲染约定。

事件载荷记录在 [docs/subsystems/session.md](../../docs/subsystems/session.zh.md)。


## 概述

todo 组为 agent（智能体）提供可用于规划的会话级任务列表：添加任务、标记进行中、逐项完成，同一份列表跨轮次、跨重新打开的会话持续存在。它只包含一个产品包，提供 `todo_write` 工具；列表属于创建它的 agent 会话，每次更新都会整体替换。交互式宿主会从列表展示当前计划，组本身不附带任何 UI。
