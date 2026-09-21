# spill/：工具输出 spill 能力家族

[English](README.md) | 中文

本家族持久化过大的工具输出，并以有界预览和取回定位信息替换内联结果。

| 包 | 职责 | ctx 键 |
|---|---|---|
| [`spill/`](spill/README.zh.md) | 定义 spill 存储 | `ctx.spillStore` |
| [`spill-local/`](spill-local/README.zh.md) | 在会话范围的本地文件中存储 spill 文本 | 注册到 `ctx.spillStore` |
| [`spill-policy/`](spill-policy/README.zh.md) | 应用执行后 spill 策略 | 监听 `ctx.tools` |

参见[工具输出 spill 决策](../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.zh.md)，其中记录了存储、保留和工具自有输出处理之间的边界。

子系统参考——`SaveTextSpill`、所有者/来源、品牌化定位符——见 [docs/subsystems/spill.md](../../docs/subsystems/spill.zh.md)；依据见[工具输出 spill Agent Note](../../.agents/notes/implemented/architecture/2026-07-08-tool-output-spill-files.zh.md)。


## 概述

`spill/` 组在模型上下文之外保存全文，并返回定位信息与取回指引。该家族拆分为 `spill/` 中的存储服务、`spill-local/` 中的本地文件系统后端，以及 `spill-policy/` 中的工具结果策略。工具结果 spill 通过 `maxInlineBytes` 按需启用，存储失败时保留原始结果。[会话引用](../context/session-reference/README.zh.md)也直接使用存储来保存已捕获但被截断的 transcript（文本记录），并自行提供预览和失败通知；它不需要工具结果策略。
