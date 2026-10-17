---
description: "持久记忆浏览与设置卡片：成员可读取、搜索并编辑的作用域条目"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-memory

[English](README.md) | 中文

记忆浏览插件的浏览器侧：通过 `sidebar.panellist` 入口打开的 `main` 页面，按作用域与 kind 列出持久记忆条目。页面读取 `memory/*` Remote API（`ctx.remote.memory`）：`memory/scopes` 返回 runtime 提供的作用域——个人 runtime 中是个人作用域加上有条目的工作区作用域，项目 runtime 中是共享的项目作用域——并附带实时条目数与按调用者判定的 `writable` 标志；`memory/list` 返回所选作用域的全部条目。服务从 `memory` 设置段返回 `enabled`，因此页面能解释为何所有 `writable` 标志都被拉低，而已存条目仍可查看。

行按 `kind` 以目录顺序分组（`guidance`、`profile`、`background`、`resource`），展示条目的更新时间、写入来源、成员 id、修订号前缀和可展开为完整 Markdown 正文的预览。客户端搜索按 key、摘要与正文过滤。归因于 agent 写入的条目通过 `uiWorkspace.openSession` 链接到来源对话，并沿用 Schedule 页面的会话/工作区列表成员判定。仅当所选作用域报告 `writable` 时才渲染创建、编辑和删除控件；编辑器以条目 `revision` 为编辑与删除做并发保护，并发修改表现为 `memory_stale`。转发的 `memory/changed` 事件与每次成功的写入都会重读目录与当前作用域；页面未挂载时不持有任何 Remote 订阅。

一张 `plugins.item` 卡片通过 `ctx.settingsScope` 绑定 `memory` 设置命名空间，提供该段唯一的开关 `enabled`；关闭后 agent 不再看到作用域且一切写入被拒绝，已存条目仍可读取。

`/client` 导出插件主体（`apply`/`inject`）、source 工厂与快照类型、卡片控制器以及注入面。

## 概述

Web GUI 新增记忆页面：成员可在个人与项目空间中浏览、搜索并在服务报告可写时编辑持久记忆；插件页新增一张可整体关闭该功能的卡片。

## 目录

- [Invariants](#invariants)
- [Model Experience](#model-experience)
- [已知限制与延后工作](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="invariants"></a>
## Invariants

**运行时不变量：** 不发布伴随检查。条目、可写性与 enabled 标志归 Host 的 `memory` 服务所有，经 Remote 读取镜像；插件不持有业务状态。

<a id="model-experience"></a>
## Model Experience

无——本包是记忆服务之上的浏览器表面，不向模型请求注入任何内容；面向 agent 的目录与工具随记忆服务自身交付。

#### KV Cache 影响

无——插件不执行任何模型可见的操作。

## 已知限制与延后工作

<a id="known-limitations-and-deferred-work"></a>

- **客户端搜索**——页面只在已列出作用域的条目内本地过滤；跨全部作用域的 Remote `memory/search` 延后。
- **无分页**——作用域一次性渲染全部条目，由服务的每作用域条目上限兜底。
- **编辑器为单条目**——无批量编辑、导入或导出界面。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文——点击展开</summary>

无。

</details>
