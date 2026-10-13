---
description: "在保留既有进程工作目录的前提下更改单个 Session 的工作目录，且更改限定在该 Session 的项目目录内。所选目录可跨重放保留，并出现在用户上下文中。目录缺失时，只要原项目仍可用就会恢复到原项目。"
kind: "package-reference"
---

# @deepseek-ai/dsh-working-directory

[English](README.md) | 中文

## 概述

在保留既有进程工作目录的前提下更改单个 Session 的工作目录。更改限定在 Session 的原始项目目录内，可跨重放保留，并出现在用户上下文中。目录缺失时，只要原项目仍可用就会恢复到原项目。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

与 `fs`、`sessionProjections`、`systemPrompt` 一同挂载。`defaultDirectory` 为没有原始目录的 Session 选择绝对路径回退目录；省略时使用启动目录。参见[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-working-directory)。

```yaml
- name: '@deepseek-ai/dsh-working-directory'
```

`ctx.workingDirectory.get(session)` 读取已提交的目录；`ctx.workingDirectory.resolve(agent, path)` 在不提交的情况下规范化候选目录；`ctx.workingDirectory.set(agent, path)` 校验并提交；`ctx.workingDirectory.ensure(agent)` 重新校验当前目录，并在其消失时恢复项目根目录。相对路径基于当前目录解析，且在符号链接解析后必须落在 Session 的原始项目内（`header.cwd`，缺失时为 `defaultDirectory`）。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

Session 投影持有有效目录，并在 Session 观察中暴露它，因此冷读方无需激活 Agent 即可使用；header 仍标识原始项目。更改按 Session 串行化，通过拥有该 Session 执行世界的文件系统提供者校验——SSH 绑定 Session 使用常驻 realm 的 `fs`，其余使用宿主机 `fs`——检查取消与 Agent 存活状态，提交事件，并入队一条用户上下文通知。若提交后通知入队失败，操作返回已提交的目录并记录告警；下一次请求或恢复仍会收到必需的目录上下文。若提供者完全无法应答（传输失败，而非目录不存在的答复），校验保留已记录的目录、不提交任何内容，并在后续校验成功前按 Session 最多告警一次。提示词组装在发布其必需上下文贡献前校验当前目录。既有进程与沙箱授权保持各自独立的所有权。[服务实现](src/index.ts)定义了 API。

不发布运行时不变量伴随件，因为该服务唯一的目录状态读自 Session 投影，并在使用时检查文件系统有效性。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Session 分组](../README.zh.md) — 持久化的 Session 服务。
- [测试](../../../docs/testing.zh.md) — 组合与重放验证。

-----

<a id="model-experience"></a>
## 模型体验

### 工作目录上下文

#### 模型看到什么

当前值为 `Current working directory: <JSON 引号包裹的绝对路径>.`。每次已提交的更改（包括自动恢复）都会尝试经由普通 Agent 收件箱入队一条用户上下文通知。取消或销毁可能丢弃未准入的通知；持久化目录对下一次请求仍然可用。目录上下文位于系统提示词之外，在可选运行时上下文关闭时仍然启用。

#### Token 影响

初始快照与更改后的值会增加用户上下文 token；未变化的快照不会重复。

#### KV Cache 影响

目录转换追加上下文，不替换稳定的系统提示词前缀。目录更改或恢复会在保留的历史之后产生新上下文。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **原始项目缺失** — 当当前目录与原始项目都不可用时，提示词组装会拒绝每一次模型轮次，包括纯聊天轮次。本服务不会选择或重建仓库。请先恢复原始目录再重试。既有 shell 保留其进程级目录。
- **SSH 文件系统缺失** — realm 未提供 `fs` 的 SSH 绑定 Session 无法校验或更改目录；服务关闭式失败，而不是读取宿主机文件系统。

<a id="dev-note"></a>
## 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
