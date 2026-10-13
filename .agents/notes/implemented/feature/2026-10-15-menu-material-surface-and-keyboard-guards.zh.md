# Agent Note：菜单材质面与键盘守卫

状态：已实现

[English](2026-10-15-menu-material-surface-and-keyboard-guards.md) | 中文

## 问题

菜单的框体此前由各调用点各自渲染：每个浮层列表自己涂 `background: var(--dsw-specific-menu)` 加自己的圆角，主菜单、输入触发选择器、命令弹层、模型选择器、坞站标签菜单之间的半透明质感与角形可能漂移。键盘处理也早于上游 alpha.2 加固层：IME 组合期按键可能驱动行导航，被模态压在下方的菜单仍会吃掉 Escape，浮层位置只在滚动/缩放时刷新，锚点被拖动或变换后列表会留在原地。

## 决策

`ui-primitives` 的 `MenuSurface` 是唯一的菜单材质。它在面内渲染半透明填充（`.material`,`backdrop-filter` + `design-platform.css` 里的 `--dsw-menu-surface-fill` 明暗双值），并在 macOS 下挂一个以每实例 CSS anchor 名定位的 body portal 衬底，让系统级 vibrancy 层有元素可附着。衬底可见性跟随面、随面卸载。`--dsw-specific-menu` 令牌现在解析到该共享填充，菜单侧自涂 `background`/`border-radius` 规则全部移除，材质恰好只涂一次。

`Menu` 原语保留本地契约——`header`、`footer`、`listStyle`、移动端 sheet 遮罩、紧凑内联子菜单变体全部保留，因为本地包（`ui-collaboration`、`ui-schedule`）在消费它们——同时获得 rc2 行为层：

- `overlayTopMargin(MARGIN)` 把 portal 顶边钳到桌面框架留白之下。
- `observeComposition(document)` 守卫全部 keydown;`isBehindModal`、`defaultPrevented`、Ctrl/Alt/Meta 修饰键整体跳过。
- Escape 走捕获期监听，放行 `Shift+Escape`，忽略 repeat；其余键保持冒泡期。
- `requestAnimationFrame` 追踪取代纯事件驱动定位，锚点在拖动或变换下保持对齐；`setFixedPos` 对相同值短路。
- `autoFocus` 经 `focusWithoutRing` 打开，与上游的指针式静默聚焦一致；键盘导航照常画环。
- `selection: 'check' | 'fill'` 选择选中行 affordance;`fill` 把高亮交给行自身。

四个消费面——输入触发 `MenuView`、命令 `PopupSelectView`、模型选择器菜单、坞站 `TabMenu`——改经 `MenuSurface` 渲染，各自的背景/圆角规则随之删除。

## 备选

**整体替换为上游 Menu。** 否决：上游删掉了 `header`/`footer`/`listStyle`，且没有紧凑移动子菜单与 sheet 遮罩，而本地包在消费这些。上游产品面更窄处保留本地 API 与行为。

**保留各菜单自涂、只换令牌。** 否决：衬底 portal 的意义在于让 macOS vibrancy 能附着到每个菜单的真实元素——只换令牌会让菜单在 macOS 上不透，也无法消除消费方忘删自涂背景时的双涂。

**只监听 scroll/resize。** 否决：锚点移动可以不触发任一事件（拖动窗口、变换祖先）;rAF 追踪每开一帧只花一对 `getBoundingClientRect`，且由 `setFixedPos` 短路去重。

## 后果

凡采用 `MenuSurface` 的面都必须停止自涂菜单背景与圆角，否则半透明填充会双涂——四个消费面因此同批迁移。移动端内联子菜单覆写隐藏 `.submenu` 内的 `[data-menu-material-fill]`，未来子菜单内新增材质层需同样豁免。`--dsw-menu-surface-fill` 自此是单一菜单填充；仍要不透明面板的面须显式退出。

## 验证

`menu-surface.client.spec.tsx` 钉住衬底落位、两实例独立锚定、卸载时移除衬底、可见性传播。ui-primitives / ui-dockkit / ui-input-trigger / ui-commands / ui-model-selection 套件（74 文件 1549 测）带换面全过，host+client `tsc -b` 双编译面干净。
