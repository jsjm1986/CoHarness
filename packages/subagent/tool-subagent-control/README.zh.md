---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-subagent-control

[English](README.md) | 中文

可选的全局具名 `send_message`、`interrupt_agent` 与 `list_agents` 工具是 `ctx.subagents` 之上的轻量适配器。绑定提供方的 `@deepseek-ai/dsh-tool-subagent` 实例会为每种传输注册不同的委派工具；这个单独加载的包只注册一次共享控制工具，因此多个委派工具绝不会重复注册全局控制工具。根插件注册 `send_message`、`interrupt_agent` 与 `subagent:identity` 提示词上下文，并将 `tools`、`subagents`、`agents` 与 `systemPrompt` 声明为加载时依赖；可单独加载的 `./list-agents` 插件注册 `list_agents`，并声明 `tools`、`subagents` 与 `agents`。其目录读取在调用时还要求会话存储与投影注册表，但不要求任何查询服务。部署可保留根插件工具并省略列表工具。是否加载这些工具不会决定委派工具是否启动可继续工作。父级与可继续子级继承同一份 `send_message` 定义与顺序，因此模型间通信不会增加任何仅子级可见的工具 schema：`send_message` 可向调用方 subagent 树中的任何其他成员 steer 消息。

本工具不执行生命周期路由：驻留、冷恢复与授权都归 subagent 服务所有。`agent` 参数是 `list_agents` 给出的名称：root 为 `lead`，也可以是 `reviewer/checker` 这样的以斜杠分隔的完整路径；与任何成员名称都不匹配的文本会被当作会话 id，因此持久化 id 同样可用。`ctx.subagents.resolveName()` 把该参数映射为会话 id，但不授予权限——随后由 `ctx.subagents.sendMessage()` 执行鉴权：调用方必须是在线的树 root 或驻留的可继续成员，目标必须属于同一棵树。正在执行轮次的目标会经 Steer 在最近的 step 边界收到消息；inactive 目标会经继续执行生命周期开启或恢复轮次，且只有冷目标会在树 root 之下物化，它自己的创建祖先可以保持离线。每条消息都以 `Agent <sender-name> sent a message:` 开头，并记录为 `{ kind: 'agent-message', form: 'relay', senderSessionId: sender.id }`；该归属由服务推导，绝不视为权限。本工具会转发其执行信号，该信号只在 inbox 接受之前掌管准入；目标一旦接受消息，便无法再通过本工具取消。本次调用不会返回回复：通过目标 id 查看其 transcript（文本记录）才是了解它做了什么的真源，回复是另一条显式指定目标的 `send_message`。失败——不受支持的目标、不在调用方树中的目标、未命中的名称、历史不可用或准入被拒——会变为出错的工具结果，并明确说明消息未送达。

`interrupt_agent(agent)` 与 `send_message` 以同样方式解析目标，然后把 `exec.agent` 作为 `ctx.subagents.interrupt()` 的确切在线 ancestor 授权传入：目标可以是直接 child 或更深的后代，由服务——而不是本工具——依据目标 Activation 记录的 lineage 校验调用方。只有目标的当前轮次会停止（`keepInbox`）：已排队的消息保持暂停直到之后的 `send_message`，已发布的后代继续运行，child 也仍可接受后续消息。调用在停止请求被接受后立即返回，不等待目标完全停稳；目标不存在或已结算是被接受的 no-op，而 self、sibling、陈旧与非 ancestor 调用方会成为出错结果。

`list_agents` 不接受参数，经 `ctx.subagents.rootOf()` 解析调用方在线的 subagent 树 root，并且不使用 cursor 遍历 `ctx.subagents.listDescendants()`，按稳定 pre-order 渲染 root 加每个可达的可继续后代。每行携带一个 `name`——root 的 `lead` 或后代以斜杠分隔的完整路径，当该成员或其下某个祖先未记录名称时退回会话 id——一个 `status`，以及一个 `description`（root 为 `root agent`，可继续后代为其持久化的创建标签）。在线状态为 `running`（正在执行轮次）或 `inactive`（没有轮次在执行，无论该成员已加载还是需恢复；它不描述任务完成或结果）。一次性 child 仍作为其自身后代的遍历节点，但因无法接受 `send_message` 而不作为行输出；不可读取的分支以 `corrupt`、`unsupported` 或 `unavailable` 诊断行呈现，表示该行自身的后代无法被读取，而行本身仍是可寻址的成员。普通的会话 fork 各自引领独立的 subagent 树。

## 概述

`dsh-tool-subagent-control` 为命名 subagent 树添加全局控制工具：`send_message` 按名称或会话 id 向树中任何其他成员 steering（中途引导），`interrupt_agent` 停止后代当前轮次但保留其收件箱与后代，`list_agents`（可单独加载的插件）列出 root 加所有可达可继续后代的名称、状态与描述。`subagent:identity` 提示词上下文告诉每个 agent 它的名称、其创建者的名称与树 root，并为已准入的工具附带指引。模型通信不增加子级专属工具 schema，且没有任何工具决定委派是否启动可继续工作。

## 目录

- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到什么

已生成的 [schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-subagent-control)：`send_message` 接受 `agent` 与 `message`；`interrupt_agent` 接受 `agent`；`list_agents` 不接受参数。

#### Token 影响

每个请求支付固定的 schema 成本，与子级数量及描述无关。

#### KV Cache 影响

前缀保持稳定；schema 不会在运行时改变，父级与其可继续子级收到完全相同的定义。

### 身份上下文

#### 模型看到什么

必需的 `subagent:identity` 运行时上下文标识每个 agent 在其 subagent 树中的名称。root 看到 `You are the root agent. Your name is "lead".`；成员看到 `You are a subagent delegated by agent "<creator-name>".`、自己的名称，以及 `The root agent of your collaboration tree is "lead".`。当 `send_message` 或 `list_agents` 被准入到该 agent 的工具集时，上下文会追加相应的使用指引。树 root 不可用的 agent 改为看到自己的会话 id 与独立工作指引。root 之下名为 `reviewer` 且两个工具都被准入的 child 会看到：

##### Subagent identity

```markdown
You are a subagent delegated by agent "lead".
Your name is "reviewer".
The root agent of your collaboration tree is "lead".

To message other agents, use send_message({ agent: "<agent-name>", message: "..." }).
Use list_agents({}) to find your collaborator agents and their names.
```

#### Token 影响

每个 agent 一条短上下文项，与树大小无关；完整名称随嵌套深度变长。

#### KV Cache 影响

前缀在成员内部保持稳定：声明在其生命周期内不变，因此写入一次运行时上下文快照。

### 中断结果

#### 模型看到什么

接受时返回 `interrupt requested for agent <agent>`，回显 `agent` 参数。未授权的调用方——self、sibling、陈旧或非 ancestor——会成为指明拒绝原因的出错结果；目标不存在或已结算仍渲染接受行。

#### Token 影响

每次调用产生一条简短确认消息；被中断轮次的中止只在子级自己的 transcript（文本记录）中可见。

#### KV Cache 影响

仅追加；每个结果都位于可复用请求前缀之后。

### 投递结果

#### 模型看到什么

接受时返回 `message delivered to agent <agent>`，回显 `agent` 参数；规范输出携带被接受的 `messageId`。失败——目标不在调用方树中、名称未命中、历史不可用，或准入被拒——会成为出错的结果，其消息说明该消息未送达。

#### Token 影响

每次调用产生一条简短确认消息；目标的响应绝不会通过本次调用返回。子级使用同一个工具，并传入其初始任务中的父级名称，将选定内容追加到父级历史中。

#### KV Cache 影响

仅追加；新增可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

### 列表结果

#### 模型看到什么

按稳定 pre-order，每个成员占一行：root 与可继续后代为 `<name> [<status>] — <description>`（`running` 表示正在执行轮次，`inactive` 表示没有轮次在执行，无论已加载还是仅存于存储），自身后代无法被读取的成员为 `<name> [<status>]`（`corrupt`、`unsupported` 或 `unavailable`）。root 是 `lead`，描述为 `root agent`；后代的名称是其相对 root 的路径，当该成员或某个祖先未记录名称时为其会话 id。一次性子级会被有意排除在行之外。

#### Token 影响

随整棵树中可达可继续成员数量线性增长；没有游标或上限，因此长期存活的树每次调用都会承担完整列表成本。

#### KV Cache 影响

仅追加；每个结果都位于可复用请求前缀之后。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **已投递的消息没有独立结果**：接受时只返回其 inbox `messageId`；目标之后的工作会落入该目标的持久化会话，绝不会通过本工具收集。回复是另一条显式指定目标的 `send_message`，不是本次调用的结果。
- **消息只在同一棵树内流转**：调用方必须是在线的 root 或驻留的可继续成员，目标必须是同一棵树中的另一个成员。只有冷目标会被物化；其创建祖先保持离线。浏览器提示词保留独立的 Queue 或 Steer 控制路径。
- **列表是快照，而非投递承诺**：它可能与发布、dispose（资源释放）或后续消息发生竞态，另一个进程也可能激活当前进程报告为 `inactive` 的成员；跨进程准确性需要共享租约。`interrupt_agent` 自己执行权威的在线 lineage 检查，因此过期的发现结果不会授予权限。
- **没有分页或删除**：系统返回完整且稳定排序的集合；只要成员的会话仍在持久化存储中，它就会继续出现在列表中，服务级上限或删除操作留待后续产品决策。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
