# Agent Note: Cordis 多会话 Workspace 工作台

Status: implemented

[English](2026-09-08-cordis-multi-session-workbench.md) | 中文

## Problem

Web 客户端只展示一个当前 Session，但运行时已经能够接收并保存不同目录的独立 Workspace 对话。跨目录工作时，用户必须不断替换当前界面才能查看或操作另一个 Session。

## Decision

浏览器提供 `conversationViewport` capability，保存最多四个根 Session id，并暴露单会话或工作台展示模式。该 capability 是一个 Cordis service，拥有可观察快照以及明确的添加、聚焦、替换、移除、模式和比例操作；它只拥有浏览器视图状态，不写入 Session 事件或 Host 数据。

现有 `conversation` slot 仍是唯一的渲染所有者。它声明显式的 `conversation.pane` 子 slot，以及工作台工具栏、空状态和面板头子 slot。每个面板都通过 renderer 的显式 SessionProvider 绑定渲染，因此无需在插件之间导入展示实现，就能复用现有 conversation slots 和 session-scoped stores。

`SessionRuntime` 同时保留当前 Session stage 和额外的 staged 集合。进入集合的 Session 会打开有界历史窗口并接收现有流式更新；移除面板只释放浏览器窗口，不会取消对应 Session。当前选择被列表暂时遮挡时仍保持 staged，直到选择移动或用户主动清除。

独立的 `@deepseek-ai/dsh-client-ui-workbench` 包只消费 Cordis service 并贡献 slot entry。它的本地状态只包含 Session id、模式、活动 id 和比例，保存在 `dsh.conversation.workbench.v1`；恢复时先与当前 Session 列表校验，再进入 staged 集合。

conversation 根入口声明 viewport store，通过 `slots.bindStore()` 与提供方共享框架拥有的实例。提供方的受控操作也包含面板重排。

Gateway 提供账户级目录，其中包含当前认证用户个人空间和按成员 ACL 可见的项目空间根会话。选择项目会按需创建带目标标记的 `ConnectionHandle`，并在运行时池中创建一个 `SessionRuntime`；池只聚合列表和 provide 查询，每个运行时仍保留自己的事件流、历史窗口和 scope 资源。Gateway 在签发 runtime principal 前重新校验成员关系，因此浏览器无法用目录中的 Session ID 访问其他项目。

个人元数据通过已认证个人运行时现有的 `session.list` 读取，因为这些历史可能仍在 JSONL 中。按 Agent 寻址的 Typert Remote 调用也会在分发前解析同一 Session 目标，因此命令、权限变更和其他 scoped capability 会跟随面板所属运行时。

## Alternatives considered

**在工作台包中复制 ConversationRoot 或 ChatView。** 这会绕过 slot ownership，并拆分现有按 Session 装配的能力。工作台改为通过显式 SessionProvider 实例渲染已有的 `conversation.pane` 授权。

**每个 Workspace 创建一条 Gateway 连接，或聚合账户项目作用域。** 账户目录只返回经过 ACL 过滤的元数据。面板选中项目会按需启动一条目标传输连接，继续使用该运行时的 principal、sandbox、approval 和事件流，不能把外部 Session 合并进当前运行时。

**只保留当前 Session staged，聚焦面板时重新加载。** 这样会丢失实时更新，并重复工作台要消除的历史打开开销。staged 集合保留四个有界窗口，同时继续使用每个 Session 原有的历史保留限制。

**使用模块单例或 window 全局保存面板状态。** 这会让状态脱离 Cordis plugin fiber 生命周期，并破坏 reload 隔离。提供方使用实例级可观察状态，并沿用仓库已有的有界本地持久化行为。

选择器以账户目录的排除结果为准。它将个人 `session.list` 与侧栏使用的 `workspace.list.archivedSessionIds` 合并过滤，排除已入索引的项目归档记录，隐藏未选中的空白草稿，并在打开 Session 前重新检查目标归档集合。

## Consequences

四个对话可以在同一个浏览器界面中同时流式更新并独立输入，每个操作仍然通过对应 Session 身份、目标运行时和现有权限路径。原来的单会话视图继续可用。Gateway 新增账户目录路由和经过校验的目标选择器；Host API 语义、Session JSONL、数据库 schema 和 Collaboration 授权规则保持不变。

renderer 和 conversation contract 变得更宽：显式 SessionProvider 解析和 pane 子 slot 成为框架责任。四个活动历史窗口比一个窗口占用更多浏览器内存，因此继续使用现有尾页和实时保留上限，并限制面板数量而不引入无界虚拟化。

[scope/provide 决策](2026-07-25-web-client-session-scope-and-provide-channel.zh.md)继续负责 Session 身份与提供方 roster 发布；[有界窗口决策](../bug-fix/2026-09-03-bounded-live-window-and-incremental-reconnect.zh.md)继续负责单 Session 的保留上限。
