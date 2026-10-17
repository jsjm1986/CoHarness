---
description: "按空间划分作用域的持久代理记忆：代理今天保存的事实，后续会话仍然可见，分为主机侧服务、按会话目录发布器、面向模型的工具和可选的策展通道"
kind: "package-group"
---
# memory/ — 按空间划分作用域的持久代理记忆

[English](README.md) | 中文

按空间划分作用域的持久代理记忆：代理今天保存的事实，后续会话仍然可见。

子系统参考文档——作用域空间、条目模式、写入规则、目录与工具帧——见 [docs/subsystems/memory.zh.md](../../docs/subsystems/memory.zh.md)。

## 概述

每个会话都从空白的上下文窗口开始。memory 组让代理把小型事实跨会话保存，并按*归属*划作用域：`personal`（关于用户，适用于所有工作区）、`workspace`（某个执行目标上的某个工作目录）或 `project`（受管项目内共享）。条目是 `memory` 存储域中的持久记录；逐会话的目录消息告诉模型现有什么，四个工具管理条目，可选通道从已结束回合中提取记忆、整合各作用域、并按最新问题召回相关条目。

## 目录

| 包 | ctx 键 | 角色 |
|---|---|---|
| [`memory`](memory/README.zh.md) | `ctx.memory` | 主机侧 `MemoryService`：作用域解析、校验、串行化写入、项目授权、有界搜索 |
| [`memory-context`](memory-context/README.zh.md) | — | `agent/pre-step` 监听器，发布已保存记忆目录并支持可选的逐问题召回 |
| [`memory-curation`](memory-curation/README.zh.md) | — | 可选的回合末提取通道与按间隔门控的整域整合通道 |
| [`tool-memory`](tool-memory/README.zh.md) | — | 面向模型的 `memory_search` / `memory_read` / `memory_save` / `memory_delete` 及 `tool:memory` 提示词指引 |

## 作用域空间

组合通过服务的 `space` 配置选择空间：

- `personal` — 本地运行时：personal 作用域 + 按目录划分的 workspace 作用域
- `project` — 受管项目运行时（Gateway 项目补丁设置 `space: project`）：单一共享作用域，写入需执行授权批准

## 不变式

- 写入在 `MemoryService` 内串行化；创建/重复/修订/容量检查按作用域原子执行。
- `memory_context` 仅在条目摘要变化、有条目变空、或可见目录被压缩遮蔽时重新发布目录。
- 面向模型的文本只存在于 `tool-memory` 和 `memory-context`；主机服务没有面向模型的输出。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
