# Agent Note: 折叠的 Chat 回合会重置其已挂载子披露

Status: implemented

[English](2026-10-18-chat-fold-disclosure-reset.md) | 中文

## 问题

Chat 让折叠的进程节点保持挂载以便实时更新继续流入，但子级的披露状态会在折叠后保留：展开一个已结算的推理或工具披露、关闭回合的进程窗口，再打开时同一批布尔值仍处于展开状态。座席在节点上设置 `hidden` 并保留其 `nodeKey` Hook 上下文，而每个披露单元（推理、上下文注入、含嵌套与 PTC 在内的逐调用工具单元）各自持有一个父级折叠无法触及的非受控展开标志。上游通过重挂载成员并在隐藏时推进披露代际来重置同一表面；这条路在这里不可用，因为卸载正是挂载节点设计刻意避免的行为。

## 决策

每个 `ChatNodeSeat` 持有一个折叠代际源（`createSnapshotStore(0)`），在 `folded` 发生 false→true 转换时递增一次，手动折叠与自动完成折叠走完全相同的路径。座席经 `hookContext`（现为携带 `nodeKey` 与重置源的 `ChatNodeHookContext` 对象）把该源交给其 `conversation.chat.node` 槽位，`apply` 在 inject `hooks` 隔间绑定 `disclosure`/`disclosureReset` Hook 工厂——与 `turnData` 已使用的同一通道。披露仅在其展开时的代际等于座席当前代际时保持展开，因此 `useDisclosure` 在折叠时收拢所有子级而无需卸载节点。`ToolCallTree` 在根部读取一次 `useDisclosureReset()` 并将版本经 `ToolCallBranch` 逐层传入每个调用单元——包括嵌套与 PTC 调用——单元记录自己展开时的座席代际并在每次读取时比较。`ReasoningRow` 与 `ContextInjectionRow` 通过注入 props 接受绑定的 `useDisclosure`，独立渲染时回退到非受控的本地源。

## 文件

- `packages/client/ui-conversation/src/client/chat/ChatNodeSeat.tsx`——持有折叠代际存储并经 `hookContext` 发布。
- `packages/client/ui-conversation/src/client/contract/slots.ts`——`ChatNodeHookContext` 取代裸字符串；`ChatNodeInjected` 暴露 `useDisclosure`/`useDisclosureReset` Hook 工厂。
- `packages/client/ui-conversation/src/client/chat/use-disclosure.ts`——`useDisclosure`、`bindDisclosure` 与 `bindDisclosureReset`，移植自上游 `use-disclosure` 语义。
- `packages/client/ui-conversation/src/client/apply.ts`——为每个 `conversation.chat.node` 渲染器绑定三个 Hook 工厂。
- `packages/client/ui-tool/src/client/tool/ToolCallTree.tsx`、`tool/tool-call-disclosure.ts`——逐调用单元记录展开代际；根部递归传递重置版本。
- `packages/client/ui-conversation/src/client/chat/ReasoningRow.tsx`、`chat/ContextInjectionRow.tsx`、`chat/AssistantMarkdown.tsx`、`chat/AssistantNodeView.tsx`、`chat/MessageItem.tsx`——绑定披露 Hook 的 props 传递。

## 备选方案

**折叠时重挂载子级。** 这是上游机制，但它丢弃了让隐藏内容持续更新的挂载节点设计；折叠还会抹去没有持久归宿的瞬时流式状态。代际比较只重置披露布尔值。

**折叠时全局清除披露信号。** 面向整回合的广播也会收拢同视图中其它回合的披露；按座席键控代际把重置范围限定在被折叠的窗口内。

**组件内订阅。** 客户端规则禁止业务组件持有订阅机制；inject `hooks` 隔间是注册方私有响应式事实的合规通道，且 `hookContext` 本就流向同一批渲染器。

## 影响

折叠回合的进程窗口——无论手动还是自动完成折叠——会收拢所有已挂载的子披露，重新打开呈现默认展示；节点与其内容保持挂载并持续更新。披露行的独立渲染保留非受控开关，既有的直接渲染测试与预览不受影响。[Chat 展示默认值决策](2026-09-14-chat-presentation-defaults.zh.md)仍拥有跨输出与结算的展开状态保留；本 note 划出折叠例外。折叠控件本身由[分组过程渲染决策](../feature/2026-10-18-grouped-process-rendering.zh.md)维护。

## 验证

`chat-view.client.spec.tsx` 对已结算的推理、上下文注入与工具披露驱动手动折叠→展开及自动完成折叠，断言 `aria-expanded` 回到 false 且节点保持挂载；`tool-call-tree.client.spec.tsx` 覆盖根、嵌套与 PTC 单元在代际递增时重置；`use-disclosure.client.spec.tsx` 固定独立开关、共享源重置与 `bindDisclosureReset` 活性。
