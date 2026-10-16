# Agent Note: 空白会话保留页头 corner 槽位挂载

Status: implemented

[English](2026-10-14-blank-session-header-corner.md) | 中文

## 问题

`ConversationSessionHeader` 在 `blank && composerPhase === 'blank'` 时卸载整棵内层树，连 `conversation.session.header.corner` 槽位一起消失。上游恰好在这个相位保留 corner——`hideChrome` 只收起标题、标签、actions 与 utilities。因为槽位消失，`ui-sidebar-right` 被迫在 `conversation.input.left` 额外注册一个 `ExpandButton` 覆盖空白会话，于是右侧栏入口存在两处挂载、两套规则。

## 决策

corner 槽位改到 blank-chrome 守卫之外渲染，与上游契约一致：空白会话下页头只挂载 corner 占用者；标题、标签、actions、utilities 延迟到会话 chrome 生效再渲染。`BlankExpandButton` 及其 `conversation.input.left` 注册删除——corner 注册现在覆盖所有相位，第二个槽位只会把同一控件渲染两遍。

- `headerBlank` 取代 `headerHidden`：空白会话下页头去掉分隔线与底部留白，保留顶部内边距使 corner 位于稳定一行；corner 自身无内容时（对空槽位用 `:has`）整行折叠。
- 非 blank 的 `titleRow` 同样把 corner 独立成座、置于 `headerUtilities` 之后，对齐上游 corner 与 utilities 的排序，而不是把槽位嵌在 utilities 内。
- 移除 `aria-hidden`：整头隐藏却内含可交互的 corner 控件，自相矛盾。

## 备选方案

**保留 `BlankExpandButton`。** corner 挂载后它会在同一画面（hero 输入行与页头）渲染两个展开控件；双重注册是绕行补丁而非功能。上游从不需要它，因为 corner 槽位从未卸载。

**blank 时整头 `display: none`。** 这正是原始缺陷：任何 corner 占用者失去挂载点，每个需要 blank 相位控件的消费者都得另找地方注册。

## 后果

右侧栏展开控件在 blank → active 切换全程可达，不再依赖输入区副本；`conversation.session.header.corner` 在所有相位承载同一契约：会话级导航槽位跨会话 chrome 相位存活。corner 无内容时页头照常折叠，无 corner 占用者的 hero 会话外观不变。

## 验证

`ui-conversation` skeleton spec —— 新增 blank 相位用例断言页头挂载且只有 corner 槽位、无 actions/utilities/标签；hero 用例断言 corner 槽位存在于挂载中的页头内。`ui-sidebar-right` spec —— 注册清单去掉 `conversation.input.left` 条目、重载计数降为 7,corner `ExpandButton` 测试直接覆盖 blank 相位。681 + 262 个测试通过。

## 相关

- [GUI Web 客户端架构](../architecture/2026-07-19-gui-web-client-architecture.zh.md) —— 这些槽位所在的组合体系。
