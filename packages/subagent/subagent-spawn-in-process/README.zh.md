---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-spawn-in-process

[English](README.md) | 中文

spawn 提供方会在当前进程中创建一个全新的子 `Agent`。子 agent（智能体）有自己的会话，看不到父 agent 的对话历史，并复用宿主的 agent 工厂及 LLM（大语言模型）/工具服务。

## 概述

`dsh-subagent-spawn-in-process` 是一个进程内 subagent 后端：它在当前进程中运行每个委派任务，子 agent（智能体）是一个全新子 `Agent`，复用宿主的 agent 工厂及 LLM（大语言模型）/工具服务。子 agent 以空对话开始，因此任务提示词必须自足；除非 `request.agentOptions` 覆盖，否则它继承父 agent 的工作目录、会话谱系、提供方、模型、推理强度与输出 token 上限。委派工具或 API 调用以 `spawn` 提供方名称找到它。需要成本最低的委派传输时选择它；需要子 agent 建立在父级已完成对话轮次之上时，请选择 fork 后端。

## 目录

- [行为](#behavior)
- [能力](#capabilities)
- [配置](#config)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="behavior"></a>
## 行为

`start(request)` 不传入 seed，直接委托给 [`startInProcessRun`](../subagent-in-process-driver/README.zh.md)，并在子 agent 发布后才返回。子 agent 获得父 agent 的工作目录/会话谱系，并默认继承父 agent 最近一次记录的提供方／模型路由（除非覆盖）；在首次请求尚未记录时回退到父 agent 的创建参数，但以空对话开始运行。

共享驱动器负责深度检查、preset 组合与描述符回放、结构化输出、通过必需的信号执行取消、单次执行、结果读取和完全停稳后的 dispose（资源释放）。启动遭拒不会留下已发布的子 agent；启动调用兑现后卸载提供方，也不会撤销由持有方拥有的运行。

<a id="capabilities"></a>
## 能力

spawn 声明 `{ agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true }`，因为它构造全新的子 agent，能够强制执行全部四项功能。启动请求上的 `agentPreset` 会挂载该 preset，而不是继承父级的组合。

<a id="config"></a>
## 配置

| 键 | 含义 |
|---|---|
| `providerName` | `ctx.subagents` 上的注册表名称（默认 `spawn`）。 |

<a id="model-experience"></a>
## 模型体验

### 子 agent 请求

#### 模型看到什么

全新子 agent 逐字接收任务内容，作为新空对话中的唯一用户消息，默认使用父级提供方、模型、推理强度、输出 token 上限与工作目录。继承或选定的 preset 提供工具和提示词片段。不包含任何父级对话消息。

#### Token 影响

子 agent 会为全新的独立上下文与历史消耗 token，不复制任何父级历史 token。preset 的提示词和工具决定重复提示词、schema 和生成 SDK 的成本。

#### KV Cache 影响

子 agent 的请求缓存与父级相互独立。子 agent 历史仅追加；preset、生成 SDK、提供方或模型变化会建立不同的子 agent 前缀。

### 父级工具结果（间接）

#### 模型看到什么

通过 `dsh-tool-subagent`，父级只接收子 agent 的最终输出，或非完成终止原因对应的出错结果；子 agent 的中间工作绝不会到达父级。

#### Token 影响

父级输入增加一个取决于数据的结果，并保留到上下文压缩（context compaction）为止。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **全新表示不含父 agent transcript（文本记录）**：子 agent 会继承 cwd、谱系、最近一次记录的路由及所选或继承的 preset 组合，但不继承父 agent 的任何对话；需要已完成轮次上下文时，请使用 fork 提供方。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
