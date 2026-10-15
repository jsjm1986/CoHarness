# Agent Note: 工作台栏格重设计——身份、折叠细条与排序

Status: implemented

[English](2026-10-15-workbench-pane-grid-redesign.md) | 中文

## Problem

多栏工作台把每一栏渲染成相同的裸列：除标题字符串外没有空间身份，焦点信号只有一道 2px 顶部发丝线，分隔条无拖拽把手指示，栏头四个图标常驻可见，"2/4" 说明文字是唯一的容量提示。非焦点栏在完成一轮回复或等待交互时没有任何信号，栏序只能通过菜单往返调整，而"暂时收起来但不关闭"这种中间姿态完全不存在。

## Decision

工作台网格成为带显式身份、姿态与注意力状态的卡片面。所有姿态存于 `ConversationViewportController` 的实时快照；[principal 拥有的工作台布局](../architecture/2026-09-23-principal-owned-workbench-layouts.zh.md)所拥有的持久化记录不新增任何字段。

- **栏身份。** 每个栏头渲染空间 tile（个人灰 / 项目蓝 / 维护琥珀）加两行身份：标题在上，`空间 · 工作区` 副标题在下。维护色调通过 `parseClientSessionKey` 与 `projectUiPolicy` 服务从栏自身的会话 id 解析——绝不取页面当前空间。`ui-workbench` 的 `ScopeTile` 是共享 tile；侧栏栏表与会话选择器消费同一解析器，同一栏在三个界面中读法一致。
- **焦点信号。** 激活栏卡顶缘挂一道 2px 实色条，边框加深一档；无光晕、无圆环、无整卡描边。
- **状态语言。** `StateDot` 增加可选 `word` 标签，在状态点旁渲染全词胶囊（`就绪`/`运行中`/`等待批准`/`运行失败`）；`data-state` 保留给自动化。
- **折叠身份细条。** `ConversationViewportSnapshot` 增加 `collapsedIds`。`setCollapsed` 把栏收成 46px 细条（tile、状态点、竖排标题、展开指示）并拒绝折叠最后一个展开栏；折叠激活栏时焦点移交给仍展开的邻栏。`soloPane` 折叠其余栏并聚焦目标栏；对已独展栏再次调用则恢复全部。`focus` 只展开目标栏。移除栏时其细条一并消失。`collapsedIds` 是纯视图状态，刻意不进入 `SavedWorkbench` 与两个 localStorage 模式版本——折叠姿态绝不跨刷新存活。
- **排序。** `ConversationViewport.reorder(id, index)` 把栏移到绝对序号并保留其宽度占比。`ConversationRoot` 从栏头 `data-pane-drag` 身份区驱动原生拖拽：源格原位变暗，悬停邻栏在落点侧长出 2px 插入条。折叠栏不可拖拽。
- **分隔条。** 每条分隔条是 `role="separator"` 控件：悬停/聚焦出胶囊把手、方向键步进、拖动中显示实时 `n% · m%` 读数、双击整行归一等宽。
- **注意力。** 顶栏胶囊统计有待交互的非焦点栏数，点击聚焦第一栏。完成回复的非焦点栏钉一枚蓝色回执点直至聚焦——由会话摘要已有的 `completed` 标记支撑，对象层在选中时清除它。
- **布局预设。** 顶栏布局菜单通过 `onViewportRatios` 应用 `equal`/`lead`/`trail` 占比预设，或切到 `tabbed` 单栏呈现——后者映射到根本地的 `soloTabbed` 标记而非快照字段。
- **命令。** 五个 `conversation.*` 命令走既有 `inject(['shortcuts'])` 路径注册——栏聚焦（桌面 `primary+digit`，Web `primary+alt+digit`，因 ⌘N 归浏览器标签页）、独展切换与退出独展。
- **配套界面。** 顶栏用座位点（`●●○○`）替换 `2/4`。侧栏栏表是发丝线行单——行首序号在悬停时换成 `⌘N` 快捷键提示、空间 tile、标题配行尾相对 `updatedAt`、状态行把状态词与 `空间 · 工作区` 合并为一行——激活栏染品牌蓝浅底、标题转蓝墨色，完成回执把状态词染成 `新回复`；相对时间与悬停显现的关闭共用行尾同一格因此永不相撞，添加是发丝线行，容量行（`已开 2 栏 · 还可加 2`）附带等宽链接，退出工作台钉在面板底部。空态是一张说明栏用途的引导卡。选择器行显示空间 tile、相对 `updatedAt` 时间与 `已在工作台`/`仅可查看` 徽章。

## Alternatives considered

**把折叠姿态存进 `SavedWorkbench`。** 否决：收起是即时的工作偏好——下次启动时遗留的细条会藏住用户已忘记收起的内容，而持久化记录归 principal 所有，陈旧细条还会跟随账号跨机器。`maximized` 模式已有先例：呈现姿态不进持久化记录。

**折叠/独展/标签态放组件本地。** 否决：聚焦、移除与键盘命令都与折叠态交互（聚焦展开、移除修剪、独展切换），放在 `ConversationRoot` 会把控制器已统一维护的不变式复制一份。`soloTabbed` 留在根本地只因它是无栏集不变式的纯布局标记。

**裁剪座的菜单改 portal 渲染。** 折叠工作暴露了模式行弹层挂在座子树内这一事实；栏收起时栏体（弹层的属主）整体卸载，不留孤儿弹层，无需 portal 改造。

**用既有 `move` 原语表达拖拽排序。** 否决：`move(id, delta)` 重复 n 次会让目标位置在拖拽中途失去绝对语义，且每步重跑占比归一化；`reorder` 一次性接收绝对序号。

## Consequences

容量、身份与注意力一瞥可读；栏可收起、可拖拽排序、可用带反馈的方式调整宽度。`SavedWorkbench` 不增字段、无需迁移——恢复的会话绝不复活细条。`focus()` 语义收窄：现在只展开目标栏而非隐式清除全部细条，测试已钉死该行为。

选择器、侧栏栏表与栏头共享同一个身份解析器；新增第四个界面只需复用 `ScopeTile` + `paneIdentity`，而非重新推导空间。

## Testing

`viewport.client.spec.ts` 覆盖折叠不变式（最后展开栏拒收、激活栏焦点移交、聚焦只展开目标、移除修剪、独展切换/恢复）与 `reorder` 的占比保留；持久化 spec 钉死 `collapsedIds` 不出现在两个记录版本。`workbench-grid.client.spec.tsx` 用可写 store 挂载 `ConversationRoot` 验证 1–4 栏数、折叠细条渲染与门槛、分隔条等宽、拖到落点排序、布局预设回调与标签模式、指针聚焦与回调路由。`assembly.client.spec.tsx` 端到端覆盖栏表座位点、空间 tile 与等宽动作。
