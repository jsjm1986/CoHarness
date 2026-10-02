---
description: "基于 user-questions seam 的模型侧 ask_user_question 工具；供组合或排查交互式 agent（智能体）表面的用户与维护者阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-ask-user

[English](README.md) | 中文

## 概述

`ask_user_question` 向用户请求确认、选择或缺失的信息。默认保持原有的阻塞式 legacy 行为不变：模型会等待用户回答。异步计时模式是显式的 Cordis 选择，设置 `mode: timed` 后启用；它等待前台窗口，随后返回待处理结果，让模型继续独立工作而问题仍可回答。在 timed 模式中，`timeout: -1` 让本次调用无限期阻塞。归属于另一个 agent 的存活子级不能调用此工具。本包不渲染界面；由调用方提供用户交互表面。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

凡模型应当能够暂停等待人类决定的场景，都可组合此插件：它提供 `ask_user_question` 工具，并且需要带有接受作用域请求的 answerer 的 `ctx.userQuestions` seam。没有 answerer 接受时，工具调用会以错误失败，而不是降级。

随附 preset 不配置此插件，因此公开原有的阻塞式 legacy 工具。要启用异步行为，请在当前 preset 的 `config.plugins` 列表中，将 `tool-ask-user` 条目显式设为 `mode: timed`：

```yaml
- id: tool-ask-user
  name: '@deepseek-ai/dsh-tool-ask-user'
  config:
    mode: timed
    timeout: 120
```

以上片段是插件条目，而不是顶层 `--patch` 条目。随附 Web profile 将它嵌套在 `preset-standard` 中，因此 Web profile 补丁必须更新该 preset 的插件列表，或在 Agent Preset 编辑器中修改同一设置。使用 `mode: legacy`（或省略 `config`）即可保持阻塞式 schema。在 timed 模式下，条目的 `timeout` 是每次工具调用的默认值。设为 `-1` 会让每次调用无限期等待，除非模型传入正数 `timeout` 参数。参数中的 `timeout: -1` 只影响该次工具调用；一次调用可以包含多个问题，并由整批答案结算。

### 何时调用该工具

当模型需要确认、选择结果或缺失的信息才能继续时，调用 `ask_user_question`。发送一个或多个问题，每个问题的 `id` 在本次调用内必须唯一，回答中会原样包含；不同调用可以复用同一个 `id`，因为调用 ID 会区分它们。推荐选项放在首位，并在标签末尾追加 `(Recommended)`。可选的单次调用 `timeout` 以秒为单位；如果没有回答就无法安全继续，则用 `-1` 让新工具保持阻塞。超时绝不表示批准。Web 卡片还允许用户显式选择“慢慢回答”或开始编辑，这会让该 Client 的 pending 等待保持无限期，直到提交回答或取消调用。选择完整旧工具是 Cordis 组合决策，不是模型参数。

```json
{
  "questions": [
    {
      "id": "cleanup",
      "question": "Proceed with the destructive cleanup?",
      "header": "Confirm",
      "options": [
        { "label": "Yes, delete them (Recommended)", "description": "Removes the three stale files." },
        { "label": "No, keep them", "description": "Aborts the cleanup." }
      ]
    }
  ]
}
```

### 模型得到什么

在超时前收到回答时，工具为每个问题返回一个回答对象：`selected` 保存选中的选项标签，`custom` 携带自由填写的回答——对多选题补充 `selected`，对单选题覆盖它。用户明确跳过的问题是一个已完成的回答项，其 `selected` 为空且没有 `custom`。相比之下，`{ "pending": true, "callId": "…" }` 表示初始等待到期前没有收到任何回答批次；问题仍可回答，模型只继续独立工作，之后的回答会作为普通用户消息送达，其 `kind`、`tool` 和 `callId` 会标识先前 pending 的工具调用。Web 对话会把该载荷展示为原问题及对应回答；其他消费者保留紧凑 JSON 文本。

```json
{ "answers": [{ "id": "cleanup", "selected": ["Yes, delete them (Recommended)"] }] }
```

### 调用何时失败

默认 legacy 模式下，工具调用始终等待用户回答。设置 `mode: timed` 后，异步工具调用会阻塞到用户作答、超时到期，或当前轮次被取消；`timeout: -1` 会让该次 timed 调用无限期阻塞。没有 answerer 接受、调用被中止、或调用方不是确切的存活运行时根，都会以模型在工具结果中看到的错误结算——最值得注意的是，归属于另一个 agent 的存活子级会被拒绝（`DELEGATED_CALLER`），必须在最终结果中包含尚未解决的问题或决定。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

可观察行为已在[使用本包](#use-this-package)中说明；本节解释工具定义及其与 seam 的关系。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 工具注册：`ask_user_question` schema、执行路径、结果渲染 |
| [`src/legacy.ts`](src/legacy.ts) | 冻结的超时功能加入前描述、参数、输出和阻塞执行 |
| — | 不发布运行时不变式伴生入口；此模型侧适配器没有独立的生命周期流；执行关系由其调用的能力 seam 负责。 |

### 消费方角色

该插件以 `['tools', 'userQuestions']` 注入，在 `ctx.tools` 上只注册一个 `defineTool` 条目。默认模式逐字注册原有的 legacy 工具——`src/legacy.ts` 中的一份冻结副本，与 timed 工具不共享任何 schema 或映射代码——每次调用都走阻塞式 `ask()`。Cordis 配置设为 `mode: timed` 时改为注册异步 schema：正数 timeout 走 `askTimed()`，`-1` 走阻塞式 `ask()`。两个定义绝不会同时出现。两者都会转发确切的调用 agent 与当前轮次信号；身份检查、waterfall（瀑布式事件）分派和错误分类由 seam 负责。timed 模式的每个请求都在 `wait` 中写明该调用，包括无限期的 `-1` 形式，Client 因此可以把提问界面绑定到这次工具调用；legacy 请求则不携带调用标识。timed schema 的 `timeout` 参数也正是 `userQuestions` projection 从记录的请求头中读取、用来区分 timed 调用与 legacy 调用的标志。

### 结果渲染

`render` 输出把结构化值经 `JSON.stringify` 投影为单个文本块，因此模型侧结果是紧凑 JSON，而非更丰富的内容块词汇。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从工具表面逐步进入 seam 约定及其 answerer waterfall。

- [用户交互子系统参考](../../../docs/subsystems/user-questions.zh.md)——此工具背后的服务约定、问题词汇与 answerer waterfall。
- [工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-ask-user)——生成的 `ask_user_question` schema。
- [user-questions 包](../user-questions/README.zh.md)——本工具消费的 seam。
- [交互组映射](../README.zh.md)——相邻的审批与命令表面。

-----


<a id="model-experience"></a>
## 模型体验

### 工具 schema

#### 模型看到的内容

随附 preset 会公开原有的阻塞式 [`ask_user_question` schema](../../../docs/tool-catalog.zh.md#deepseek-aidsh-tool-ask-user)。自定义 Cordis 行设置 `mode: timed` 后，会切换到包含问题 id、提示语、标题、选项、多选标志、`timeout` 与待处理结果的异步 schema；模型只会看到被选中的定义。

#### Token 影响

工具可见时，每个请求都会产生固定的 schema token 开销。

#### KV Cache 影响

只要定义和可见性保持不变，前缀即可稳定复用。插件生命周期变化或作用域限制可能会使从此 schema 起的缓存复用失效。

### 工具调用历史与结果

#### 模型看到的内容

模型提出的完整问题保留在 assistant 工具调用参数中。前台等待期间收到的回答会在下一步显示为精确采用 `{"answers":[{"id":"<id>","selected":["<label>"],"custom":"<text>"}]}` 形式的紧凑 JSON；不使用 `custom` 时会省略该字段，`selected` 可以包含零个、一个或多个标签。待处理这一步显示为一个紧凑的 `{"pending":true,"callId":"<pending-call-id>","message":"<instruction>"}` 对象，其 `message` 指示模型继续独立工作；指示是对象里的字段而不是对象旁的自然语言，因为记录下来的结果文本还会被问题 projection 和 Web 卡片当作一个 JSON 对象读回。返回待处理结果后，最终回答会作为形如 `{"kind":"answer_to_pending_question","tool":"ask_user_question","callId":"<pending-call-id>","questions":[...],"answers":[...]}` 的用户消息送达。判别字段和调用 id 会明确告诉模型这是对先前 pending 调用的回答，重复的问题则让回答保持自包含。调用等待期间的 UI 交互不属于模型上下文。

#### Token 影响

参数和回答 JSON 是依数据而定的保留 token；等待用户时不会产生 token 开销。

#### KV Cache 影响

仅追加；新出现的可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明该工具何时不合适。它们是当前包约束，不是 UI 积压事项。

- **旧版工具不会报告 pending**：`mode: legacy` 保留阻塞式的内存等待，只返回回答或错误。它的调用永远不会进入 `userQuestions` projection，因为请求头记录的是 legacy schema，所以被进程丢失打断的旧版调用不会显示已继续的问题，也不接受迟到回答，与 timed 问题出现之前完全一致。
- **运行时中归属于其他 agent 的 subagent 不能向用户提问**：`ask_user_question` 会以 `DELEGATED_CALLER` 拒绝归属于另一个 agent 的存活子级；该子级必须在最终结果中包含尚未解决的问题或决定。持久谱系不能决定这一边界，因此带有谱系的会话恢复为运行时根后可以正常提问。
- **Native 回答渲染为 JSON 文本**：规范值仍为结构化数据，但模型侧结果使用紧凑 JSON，而非更丰富的内容块词汇。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

推广顺序是先在采用期间保留两种工具定义，再把 timed 工具设为默认，最后在现有 profile 完成迁移后移除 legacy 定义和 `mode: legacy`。移除旧工具的可执行代码不得改变历史 Session 的重放行为：[`userQuestions` projection](../user-questions/src/projection.ts) 必须继续根据每个 `request/header` 记录的 schema 区分调用；现有的[混合 schema 测试](../user-questions/tests/projection.spec.ts)已覆盖这一点。缺少 `timeout` 参数不能用来识别旧调用，因为 timed 调用也可以省略它。timed 模式下的 `timeout: -1` 提供无限期等待，但不会重现旧 schema 或卡片行为。如果移除过程中改变 projection 状态或折叠语义，应提高 `stateVersion`，让持久化缓存从日志重新折叠。

</details>
