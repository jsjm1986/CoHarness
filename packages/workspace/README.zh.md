# workspace/：workspace 实体家族

[English](README.md) | 中文

本家族拥有持久 workspace：带标题和有序会话成员关系的用户目录。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`workspace/`](workspace/README.zh.md) | 注册 workspace 并记录其会话归属 | `ctx.workspaceRegistry` |

[workspace 包参考](workspace/README.zh.md)负责生命周期、持久化和删除语义。

子系统参考——实体、realpath 规范、注册/解析——见 [docs/subsystems/workspace.md](../../docs/subsystems/workspace.zh.md)；存储设计见 [domain KV 存储 Agent Note](../../.agents/notes/proposed/architecture/2026-07-24-domain-kv-storage-and-workspace.zh.md)。


## 概述

workspace 家族让宿主产品持久保存命名且有序的项目列表，并按目录归组每个项目的会话。用户可以浏览这些项目与会话、将会话从分组中隐藏而不删除该会话，以及移除项目而不删除其文件夹或会话历史。被隐藏或从项目中移除的会话仍可作为未分组的历史记录使用。需要持久项目界面时选用此家族；它需要会话存储和持久化后端，且不会向模型公开工具、提示词或会话事件。
