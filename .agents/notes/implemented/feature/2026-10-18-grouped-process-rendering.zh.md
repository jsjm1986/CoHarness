# Agent Note: 分组化过程渲染与 Turn 过程折叠控件

Status: implemented

[English](2026-10-18-grouped-process-rendering.md) | 中文

## Problem

Chat 曾将助手回复之间的每一行过程证据渲染为平铺流，因此无论工作详情偏好如何设置，已完成 Turn 的推理、上下文、工具调用与重试都保持完全展开。展示策略表中的 `stepGrouping` 与 `liveProcessDetail` 开关存在但没有渲染消费者：compact、standard、detailed 与 verbose 产出完全相同的界面。当时也没有每个 Turn 的过程控件——上游那种已收官的 `已完成`/`已停止`/`处理失败` 折叠开关——也没有任何合成节点锚定该开关所拥有的窗口，因此证据、回答与 Turn 级行之间没有明确的折叠边界。

## Decision

该行为移植到现有的 `ui-conversation` 架构上，而非照搬上游拆分的 `ui-chat` 包。运行时 `ChatSnapshot` 发布 `entries`——有序的 `ChatFlowEntry` 根项，每项或为一个 Node（可为拆分 Node 的某一个 `groupPart`）或为一个 `group`——以及一个稳定存活的 `groups` 仓库，保存 `ChatGroupSnapshot` 成员；两个字段都是必填，`EMPTY_CHAT_SNAPSHOT` 与字面量测试构建器提供空默认值。Node 的业务 kind 在 `group-tree.ts` 中选择一个位置：`input`（user、steering、`turn-trigger`）、`turn`（system prompt、过程控件、tail、error、max-tokens）、`process`（`model-retry`），或 undefined——后者加入其周围的过程运行段。

`turn-process.ts` 为每个 Turn 投影出 `TurnProcessSpec`——`controlAnchorSeq`、`processStartSeq`、`answerStep`、`answerAnchorSeq`、`inlineReasoning` 以及消息/工具调用/subagent 计数——并在 `turn/start` 加上负值 `processControl` 偏移处发射一个合成的 `turn-process` 节点，因此即使 `turn/start` 先落账，控件也渲染在开场人类输入之后。`ProcessFlowProjector` 把可见 Node 顺序划分为分组窗口：助手回复之间连续的未定位 Node 构成一个分组，其标题取自 `processActivity` 活动类别加有界任务详情；`assistant-step` 把推理部分归入运行段、回复部分留在段外；`process` 级行会中断运行段但不加入分组。

`ChatView` 按 Turn 在控件之后折叠：锚定在 `processStartSeq` 及以后、`answerAnchorSeq` 之前的成员隐藏，`TURN_PROCESS_INDEPENDENT` 中的 kind 与答案锚点 Assistant 保持在窗口之外，进行中、已停止、失败或含穿插输入的 Turn 永不折叠。折叠的成员保持挂载以接收实时更新，同时 `ChatNodeSeat` 注入的展开项 hook 将它们重置；`ChatGroupSeat` 持有本地 `useDisclosure`，在 `stepGrouping: 'collapsed'`（compact、standard）下分组所有 Turn，在 `'history'`（detailed，最新 Turn 延迟到下一次输入）下仅分组已关闭的 Turn，在 `'none'`（verbose）下不分组，并仅当 `liveProcessDetail` 开启时才在展开的分组标题中显示运行中的任务详情。`TurnProcessNodeView` 只为已关闭的 Turn 绘制结果标签与 `data-turn-process-*` 计数属性，窗口无内容或不可折叠时禁用。

## Alternatives considered

**整体照搬上游的 `ui-chat` 包。** 否决：fork 的 Chat 投影、注册接缝（`conversationEvents` 而非 `uiConversation.events`）与 Session 组装方式不同；复制整个包会让同一界面出现两份实现，并架空已有的集成 fixture 测试基座。

**只在平铺行上加折叠控件。** 否决：会丢失各模式定义上应产生差异的类别标题分组与逐组实时详情，使上游缺口只移植了一半。

**只用 kind 集合而不设位置映射。** 否决：`model-retry` 必须位于运行段之间——在分组之外但在折叠窗口之内——单一的独立集合无法表达这一点；三级位置映射以 kind 声明的方式复刻了上游逐 Node 的 `groupTree` 语义。

## Consequences

已完成 Turn 折叠在一个带结果标签的控件之后，过程证据按活动类别分组、仅在策略允许处携带实时详情，四个工作详情模式现在产出明显不同的会话流；回放、前置追加、追加以及运行中到已收官的转换都保持 Node 与分组身份。字面量 `ChatSnapshot` 构建器与 cordis inspect API catalog 新增了必填字段。分组流、折叠窗口、结果标签、排序锚点、展开项重置与模式矩阵均由 `chat-snapshot-fixture` 驱动的 ChatView 规格与 conversation-node-definition 规格锁定。本 note 在 [Conversation 节点组装决策](../architecture/2026-08-09-client-conversation-node-assembly.zh.md)的快照模型上扩展 `entries`/`groups`，承接[展示默认值决策](../bug-fix/2026-09-14-chat-presentation-defaults.zh.md)委托的轮次级过程折叠，并与[折叠展开重置决策](../bug-fix/2026-10-18-chat-fold-disclosure-reset.zh.md)共享折叠面——后者拥有其展开语义。
