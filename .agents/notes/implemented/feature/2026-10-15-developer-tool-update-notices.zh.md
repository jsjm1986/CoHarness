# Agent Note:developer 工具更新以紧凑上下文通知呈现

状态：已实现

[English](2026-10-15-developer-tool-update-notices.md) | 中文

## 问题

工具名册在轮次间变化时，agent loop 会记录 `developer/message` 事件——skill 或 preset 激活以耐久的 `tool-addition`/`tool-removal` 内容块增删工具名——但没有任何 conversation target 匹配该事件，因此名册变化虽到达模型却在 Chat 与 Trajectory 中都不可见。上游来源：`7e5f9069454`(alpha.2 内）。

## 决策

developer 历史在两个 target 都并入上下文呈现。Chat 中一个 `developerMessageDefinition` 共享 input-message 生命周期：它把 `data.message` 按消息 id 投影为 `ContextMessageNode`，使 `contextProducer`/`contextForm` 像处理注入 `user/message` 一样读其耐久来源。Trajectory 的输入 Definition 以同一节点形态匹配该事件。两处渲染器对只含工具变更块的内容特判：单块就地点名工具且不可展开；多块折叠为「工具已更新」标题并携带新增／移除计数，展开后按变更类型逐行给出名称清单。单工具的 trajectory 单元格仅作呈现——退出 Tab 序、不获得选择／展开处理器。混合内容保留通用上下文呈现。

## 备选方案

**专用 `tool-update` 节点类型与卡片。** 上下文展开项已拥有折叠／展开的紧凑几何、生产者标签约定与未知生产者的 opaque 兜底；第二个展开项只会为同一批耐久事实重复整套机制。

**对照请求头解析新增项。** 单元格呈现的是名称而非 schema——产生该事件的头部 diff 本就耐久；为已移除工具还原 schema 需重放查看者可能已分页出去的头。

## 影响

工具名册变化在其耐久之处同时出现在 Chat 与 Trajectory。携带普通文本的 developer 消息渲染为无名上下文行与 opaque 正文，即文档化默认。本地 Chat 让所有上下文行可见，因此无需可见性豁免；上游对普通 Context 的行抑制在本地并不存在。

## 验证

`conversation-node-definitions.client.spec.ts` 在 replay/live/prepend 三种窗口下把工具变更事件装配为 context 节点，并在无已加载头时保留移除项。`tool-updates.client.spec.tsx` 渲染双语折叠计数与展开名称清单，以及单块不可展开标题。`conversation-definitions.client.spec.ts` 与 `layout.client.spec.tsx` 覆盖 trajectory 节点与单元格文本／明细投影（双语）。

## 关联

- [2026-08-04 Web 上下文来源与插话标记](2026-08-04-web-context-source-and-steer-marks.zh.md)——本通知对纯工具内容抑制的生产者标签约定。
- [2026-08-05 上下文形态词汇](2026-08-05-context-form-vocabulary.zh.md)——通用路径仍遵循的形态轴。
