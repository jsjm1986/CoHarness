---
description: "提供一个外部子智能体工具，为每个任务选择已配置的运行时。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-tool-subagent-oar

[English](README.md) | 中文

## 概述

使用一个 `subagent_oar` 工具，为每个独立文本任务选择已配置的外部智能体。配置固定可用的运行时别名及其提供方；模型选择别名，不能更改原生参数或权限。每个任务使用独立上下文并返回子任务的名称，随后作为 `subagent` 后台作业运行，其结算通知送达父智能体。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [延伸阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与待完善事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已配置的外部提供方旁挂载此工具，例如 [OAR 提供方实例](../subagent-oar/README.zh.md)。在组合中将工具包和提供方包声明为依赖。

### 适用场景

当一个模型可见入口需要在独立的单次提供方之间选择时，使用此工具。它拒绝继承父对话或支持继续执行的提供方。需要可继续的子智能体或更多子任务配置时，请使用[共享子智能体工具](../../subagent/tool-subagent/README.zh.md)。

### 最小配置

在 `oar-codex` 和 `oar-claude` 已注册的情况下，在组合中挂载此行：

```yaml
- name: '@deepseek-ai/dsh-experimental-tool-subagent-oar'
  config:
    providers:
      codex: oar-codex
      claude: oar-claude
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providers` | 必填 | 从模型可见运行时别名映射到已注册提供方名称的非空映射 |
| `toolName` | `subagent_oar` | 工具名称；每个挂载实例需要不同名称 |

[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-experimental-tool-subagent-oar)定义接受的字段和校验规则。调用要求提供 `runtime`、`description` 和 `prompt`。可选的 `name` 在此工具为该父智能体起过的名称中为子任务保留一个名称：1–32 个小写字母、数字或连字符，以字母开头，且不能为 `lead`；省略时依次选择 `agent-1`、`agent-2` 等。可选的 `cwd` 选择子任务目录，相对路径从父智能体的当前目录解析。提示必须包含子任务需要的上下文。原生安装、认证、模型设置和权限由所选提供方负责。

组合还必须提供 `ctx.jobs` 实现，例如 [`@deepseek-ai/dsh-jobs-local`](../../jobs/jobs-local/README.zh.md)；没有时调用会失败。[`@deepseek-ai/dsh-tool-jobs`](../../jobs/tool-jobs/README.zh.md) 提供面向模型的 `job_output`、`job_list`、`job_kill` 控制以及完成通知。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节 — 点击展开</summary>

[`src/index.ts`](src/index.ts)根据配置的别名构建运行时枚举，并注册一个工具。每次调用先在此工具为该调用方起过的名称中保留一个名称，解析其提供方，然后等待共享子智能体服务的单次启动；该服务负责准入、能力检查、子目录解析、目录记录以及发布前调用方取消。已发布的运行随后注册为调用方拥有的 `subagent` 作业：作业负责终止请求和最终记录，[`dsh-tool-jobs`](../../jobs/tool-jobs/README.zh.md) 将结算作为父智能体的完成通知送达。结算中失败的释放会交回子智能体服务，由同一父智能体重试。工具调用卡片使用任务描述和提交的参数。结果以展示元数据记录 `{ kind: 'activation', name }`。释放插件会移除其工具注册；已发布的运行及其作业保留各自的所有者。

</details>

-----

<a id="further-exploration"></a>
## 延伸阅读

- [子智能体服务](../../subagent/subagent/README.zh.md) — 提供方注册和激活所有权。
- [OAR 提供方](../subagent-oar/README.zh.md) — 原生运行时配置和权限配置。
- [子智能体子系统](../../../docs/subsystems/subagent.zh.md) — 父智能体完成通知和保留结果。

-----

<a id="model-experience"></a>
## 模型体验

### 外部委派工具

#### 模型看到什么

[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-tool-subagent-oar)定义描述和参数 schema。`runtime` 枚举包含配置的别名。接受任务后，工具返回 `started subagent <name>`，其中 `<name>` 是为该子任务保留的名称，例如 `reviewer`。运行结算时，[`dsh-tool-jobs`](../../jobs/tool-jobs/README.zh.md) 送达一条指明子任务作业的完成通知，`job_output` 返回其最终答复或失败详情。

#### Token 影响

每个挂载实例添加一个工具 schema，其中包括可选的 `name` 字段。确认和完成通知追加到父上下文；提供方负责子任务的独立上下文和 token 使用。

#### KV Cache 影响

修改配置的别名、工具名称或注册会改变后续请求中的工具 schema。确认和完成通知追加在可复用的父请求前缀之后。

## 已知限制与待完善事项

<a id="known-limitations-and-deferred-work"></a>

工具的选项和执行能力由已配置的提供方固定。

- **仅支持单次提供方：** 子任务上下文独立，工具不提供后续输入、恢复、结构化输出或按调用覆盖原生权限的功能。
- **提供方可用性：** 选择的提供方不存在或已卸载时，调用会失败；其配置的别名会保留在 schema 中，直到此工具的配置改变。
- **父智能体交付需要作业：** 未挂载 `ctx.jobs` 实现时调用会失败；面向模型的结果收集和完成通知还需要 `dsh-tool-jobs`。
- **提供方负责的工作：** 运行时配置、启动取消、进程清理和答复选择遵循所选提供方的文档行为。移除此工具不会撤销已发布的运行或其作业。
- **工具级名称作用域：** 保留的名称仅在此工具为同一父智能体创建的子任务之间唯一；其他委派路径声明的名称不会被检查。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文 — 点击展开</summary>

无。

</details>
