# skill/：skill（技能）能力家族

[English](README.md) | 中文

本家族发现可复用的 agent（智能体）指令，并通过与提供方无关的目录和 loader 将其公开给模型。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`skill/`](skill/README.zh.md) | 定义 skill 提供方注册和查找 | `ctx.skills` |
| [`skill-badge/`](skill-badge/README.zh.md) | 贡献可选的内置 dsh 徽章 skill | 注册到 `ctx.skills` |
| [`skill-filesystem/`](skill-filesystem/README.zh.md) | 从本地文件系统发现 skill | 注册到 `ctx.skills` |
| [`tool-skill/`](tool-skill/README.zh.md) | 发布 skill 目录和面向模型的 loader | 注册到 `ctx.tools` |

该能力位于核心控制主干之外，可以使用本地、嵌入式或远程提供方，而无需更改面向模型的约定。

子系统参考——发现优先级、目录快照、`skill` 加载器——见 [docs/subsystems/skills.md](../../docs/subsystems/skills.zh.md)。


## 概述

skill 家族让 agent 和用户仅在需要时发现并加载可复用的任务指令。使用 `skill/` 合并目录并为每个名称提供一组指令；需要从项目、自定义或用户目录发现 skill 时选择 `skill-filesystem`，需要可选的官方徽章时选择 `skill-badge`，需要 Word、PowerPoint 和 Excel 工作流时选择 `skill-office`。需要让模型获得排序且持久的会话目录、通过 `skill` 工具加载完整指令，或接受 `/name` 直接调用时，请添加 `tool-skill`。不同来源生成相同的模型可见格式，启用模型访问前必须配置至少一个来源。
