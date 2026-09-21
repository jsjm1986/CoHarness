# @deepseek-ai/dsh-subagent-spawn-in-process

[English](README.md) | 中文

spawn 提供方会在当前进程中创建一个全新的子 `Agent`。子 agent（智能体）有自己的会话，看不到父 agent 的对话历史，并复用宿主的 agent 工厂及 LLM（大语言模型）/工具服务。

## 概述

`dsh-subagent-spawn-in-process` 是一个进程内 subagent 后端：它在当前进程中运行每个委派任务，子 agent（智能体）是一个全新子 `Agent`，复用宿主的 agent 工厂及 LLM（大语言模型）/工具服务。子 agent 以空对话开始，因此任务提示词必须自足；除非 `request.agentOptions` 覆盖，否则它继承父 agent 的工作目录、会话谱系、提供方、模型、推理强度与输出 token 上限。委派工具或 API 调用以 `spawn` 提供方名称找到它。需要成本最低的委派传输时选择它；需要子 agent 建立在父级已完成对话轮次之上时，请选择 fork 后端。

## 行为

`start(request)` 不传入 seed，直接委托给 [`startInProcessRun`](../subagent-in-process-driver/README.zh.md)，并在子 agent 发布后才返回。子 agent 获得父 agent 的工作目录/会话谱系，并默认继承父 agent 最近一次记录的提供方／模型路由（除非覆盖）；在首次请求尚未记录时回退到父 agent 的创建参数，但以空对话开始运行。

共享驱动器负责深度检查、persona 与工具过滤器设置、结构化输出、通过必需的信号执行取消、单次执行、结果读取和完全停稳后的 dispose（资源释放）。启动遭拒不会留下已发布的子 agent；启动调用兑现后卸载提供方，也不会撤销由持有方拥有的运行。

## 能力

spawn 声明 `{ outputSchema: true, depthLimit: true, toolFilter: true, persona: true }`，因为它控制子 agent 的创建窗口，能够强制执行全部四项功能。

## 配置

| 键 | 含义 |
|---|---|
| `providerName` | `ctx.subagents` 上的注册表名称（默认 `spawn`）。 |

## 不变量

**运行时不变量：** 未发布配套入口。子 Agent 由共享驱动器在调用内创建并释放；提供方不拥有运行后状态。

## 模型体验

### 子 agent 请求

#### 模型看到什么

全新子 agent 逐字接收任务内容，作为新空对话中的唯一用户消息，默认使用父级提供方、模型、推理强度、输出 token 上限与工作目录。配置的 persona 会在子 agent 作用域中遮蔽全局提示词文本；工具过滤器会从其 schema、可执行工具查找与 PTC mode SDK 绑定中移除指定的全局工具，但保留独立注册的指导内容。不包含任何父级对话消息；过滤属于组合，而非继承的权限授予。

#### Token 影响

子 agent 会为全新的独立上下文与历史消耗 token，不复制任何父级历史 token。persona 会改变该子 agent 反复使用的提示词成本；工具过滤器会改变其 schema 或生成 SDK 的成本。

#### KV Cache 影响

子 agent 的请求缓存与父级相互独立。子 agent 历史仅追加；persona、工具过滤、生成 SDK、提供方或模型变化会建立不同的子 agent 前缀。

### 父级工具结果（间接）

#### 模型看到什么

通过 `dsh-tool-subagent`，父级只接收子 agent 的最终输出，或非完成终止原因对应的出错结果；子 agent 的中间工作绝不会到达父级。

#### Token 影响

父级输入增加一个取决于数据的结果，并保留到上下文压缩（context compaction）为止。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

## 已知限制与暂缓事项

- **全新表示不含父 agent transcript（文本记录）**：子 agent 会继承 cwd、谱系、最近一次记录的路由及显式配置的 persona/工具限制，但不继承父 agent 的任何对话；需要已完成轮次上下文时，请使用 fork 提供方。
