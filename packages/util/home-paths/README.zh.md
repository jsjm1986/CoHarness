---
description: "English | 中文"
kind: "package-library"
---

# dsh-home-paths

[English](README.md) | 中文

DeepSeek Harness 用户数据的共享文件系统路径辅助工具。

## 概述

`@deepseek-ai/dsh-home-paths` 让包作者能够解析 DeepSeek Harness 数据根目录及其消费者读取的共享 agent 配置根目录。显式路径优先于环境变量，后者优先于操作系统主目录下的默认值；空白环境变量会被忽略。其公开辅助函数可以在不暴露机器绝对路径的情况下显示根目录，仅展开单独或当前用户的波浪号形式，并规范化最终路径段尚不存在的监听目标。请把它作为库依赖直接使用，不要通过 `cordis.yml` 加载。

## 目录

- [DSH 主目录](#dsh-home)
- [监听路径](#watch-paths)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="dsh-home"></a>
## DSH 主目录

`resolveDshHome()` 解析 DeepSeek Harness 的单根主目录。优先级从高到低为：显式配置的路径、`$DSH_HOME`、`~/.dsh`。harness 将所有用户数据保存在同一根目录下。

`dshHomePath(...segments)` 使用 Node 的平台路径规则，将子路径段拼接到解析后的主目录下。不传入任何路径段时，返回主目录本身。

`dshHomeDisplay()` 以符号方式表示当前根目录，用于面向用户的路径：默认主目录表示为 `~/.dsh`，任何已配置的主目录表示为 `$DSH_HOME`。它绝不会泄露机器的绝对路径。

`DSH_HOME_DIR_NAME` 定义默认用户数据目录名：`.dsh`。

`defaultDshHome()` 使用 Node 的平台路径规则，将操作系统主目录与 `.dsh` 拼接，并返回默认 DeepSeek Harness 主目录。

`resolveAgentsHome()` 以相同的优先级、空白值处理与波浪号展开规则解析共享 agent 配置根目录：配置的路径、`$DSH_AGENTS_HOME`（`AGENTS_HOME_ENV`）、`~/.agents`（`AGENTS_HOME_DIR_NAME`）。该根目录刻意位于 `$DSH_HOME` 之外，因为其他 agent 工具共享它；`dsh-agent-instructions` 读取其用户全局 `AGENTS.md`，`dsh-skill-filesystem` 扫描其 `skills/` 目录。`defaultAgentsHome()` 返回默认的 `~/.agents` 根目录。

`agentsHomeDisplay()` 以符号方式表示该根目录：默认根目录显示为 `~/.agents`，任何已配置的根目录显示为 `$DSH_AGENTS_HOME`。两种显示形式都不会泄露机器的绝对路径。

`expandHomePath()` 使用操作系统主目录展开 `~`、`~/...` 和 Windows 风格的 `~\...` 前缀。它会保留非波浪号路径和 `~user/...` 原样不变。

<a id="watch-paths"></a>
## 监听路径

`canonicalizeWatchPath()` 为原生文件系统 watcher 提供一种稳定的目标路径表示。它通过 `fs.realpath()` 解析层级最深的现有祖先路径，再拼回缺失的后缀，因此即使文件或目录尚未创建也仍可监听。尤其是，Windows 8.3 别名不能与原生 watcher 后端发出的长路径混用。

该包刻意保持规模小且不依赖 harness，以便产品包共享用户数据路径约定，而不必彼此依赖。

**运行时不变式：** 不发布伴生入口。这个纯工具包不持有事件流或可变运行时数据；其解析规则和值代数由单元测试保障。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **展开范围刻意保持狭窄**：只有单独的 `~`、`~/...` 和 `~\...` 使用当前操作系统主目录；`~alice/...` 等指定用户的形式、环境变量和 shell 表达式保持不变。
- **规范化会读取，但绝不修改**：`canonicalizeWatchPath()` 会执行 `realpath` 探测，并传播除路径不存在以外的错误；调用方仍负责目录创建、权限，以及对结果路径应用信任策略。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
