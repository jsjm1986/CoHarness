# Agent Note: 右栏的手机呈现是推入屏，不是缩小的停靠面板

Status: implemented

[English](2026-10-14-rightbar-phone-presentation.md) | 中文

## 问题

768px 以下右栏已自动全屏（`AppFrame`），但仍带着桌面 chrome：28px 控件、一个只能充当"第二个关闭"且会改写桌面模式记录的全屏模式按钮、悬浮在半屏中间的胶囊式引导条目，且没有滑动手势——唯一出口是一个小图标。第一次尝试用样式表 `display:none` 移除宽度受限的分栏控件时，标签条的弹性填充吸收了释放出的空间，下一次房间测量翻转了分栏判定，控件重新渲染又占回空间——形成无限更新循环（React #185），整个 `rightbar.session` 槽位被卸载。由于保留的隐藏会话视图在 DOM 中留下陈旧的展开按钮，这次崩溃最初看起来像测试选择器问题。

## 决策

按[紧凑密度 note](../architecture/2026-10-13-compact-density-refinement.zh.md) 的语法，把手机面板当作推入屏处理。`PanelChrome` 在 `autoFullscreen` 下把停靠图标换成纯关闭字形并省略模式按钮——在这种呈现下该按钮只能充当重复关闭，同时还会污染桌面模式记录。`SidebarPanel` 挂接 `useLeadingEdgeDismiss`：原生 touch 监听（React 的 touch 是 passive）只接受起于前缘 20px 内的右向拖动，垂直漂移在写入任何 transform 之前取消候选；拖动的节点是持有稳态 transform 的 dockkit 宿主，松手时超过约 30% 宽度或 0.35px/ms 速度则关闭，否则弹回并清除全部内联值。引导条目采用平铺列表语法——顶部锚定的整宽行、发丝分隔线挂在 `.entryCell` 包装器上，使槽位提供的条目（如终端自己的行）也能继承分隔线——标签条的 chip、控件与 tab 菜单项全部进入紧凑几何。

## 验证

`swipe-check.e2e.ts` 用真实 touch 事件走完整序列：抽屉边缘滑开、sheet 短拖弹回与长拖关闭、modal 拖拽关闭、右栏深处横向拖动不得关闭、前缘拖动必须关闭。`seat.client.spec.tsx` 在 390px 挂载并断言被禁分栏控件经 kit 的 `hideSplitWhenBlocked` 渲染路径缺席；`compact-styles.client.spec.ts` 断言样式表永不隐藏它；`guide-styles.client.spec.ts` 钉住平铺行契约。测量环崩溃可在 抽屉→sheet→modal 序列下复现，可见性移入 kit 路径后消失。

## 备选方案

**在样式表里隐藏被禁分栏控件。** 否决：这正是上述循环。`geometry.ts` 已警告 `splitControlWidth` 参与房间判定；`hideSplitWhenBlocked` 的存在就是为了让测量保持足迹不变、渲染路径再移除节点。

**把关闭手势做在壳层抽屉边缘滑动旁边。** 否决：该手势的生命周期属于面板（`autoFullscreen && expanded`），目标节点是面板内的 dockkit 宿主，壳层监听还得重新发现这两者。面板内实现让边缘区、transform 归属和关闭动作留在同一组件里。

**保留模式按钮作为出口。** 否决：两个叠放的"类关闭"比一个不掺杂的关闭更差，且 `toggleFullscreen` 会持久化桌面布局下次读取的模式（见[停靠 note](2026-09-04-right-sidebar-docking-infrastructure.zh.md)）——隐藏它使桌面记录不受影响。

## 后果

- 手机标签条控件 36px、chip 32px，长按菜单项达到共享触控目标；标签条总带宽不变，更高的行从其底部内距中取得。
- `SlotErrorBoundary` 的崩溃日志现在附带 `componentStack`；槽位渲染失败无需重编 React 即可定位。
- 今后任何可见性由 dockkit 房间测量决定的控件，必须经 kit 路径隐藏（`hideSplitWhenBlocked` 或同类标志），绝不能用样式表规则——测量读取的正是规则会改变的布局。
