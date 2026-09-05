# @deepseek-ai/dsh-client-ui-theme

[English](README.md) | 中文

主题插件：基于 --dsw-* token 基础样式表（静态尺度 + 别名语义层）的 ThemeRuntime。该服务拥有实时主题偏好（`light`／`dark`／`system`），将 `system` 通过 `prefers-color-scheme` 解析为实际主题，并发布不可变的 `ThemeSnapshot`，通过 `theme/change` 事件通知变化；它绝不接触 DOM：ui-layout 的呈现器会应用解析后的快照（`html { color-scheme }`、`body[data-ds-dark-theme]`，以及主题的别名 token 内联变量）。来自回环地址的浏览器会先以 `system` 立即提供该服务，随后在后台加载 `ui-theme.preference`，并将每次内置主题选择通过 Host settings API 写入；其本地提供方默认将设置存入 `$DSH_HOME/settings.yaml`。收到推送的 settings 变更时或重连后，浏览器都会重新拉取该设置；连续快速选择会按操作顺序携带 namespace revision 串行写入，最新写入被拒时则重新加载持久化值。经网关把 `Host` 改写成实例回环的公网页写入同一条 Host 设置；未通过特权方法栅栏的请求停在内存默认值。已注册的第三方主题 id 仍是进程内扩展，不会跨越内置 settings schema；移除其中任意一个都绝不会覆盖最后一个持久化的内置偏好。该持久化边界由[Host settings 支撑的偏好决策](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.zh.md)拥有。

当主机组合包含 HTTP 服务器时，主机侧紧接 `<body>` 起始标签注入同步引导代码。每份 index 响应会嵌入已注册的 Host 设置 `ui-theme.preference`，没有 settings provider 时则嵌入 `system`；浏览器按操作系统配色解析 `system`，随后在外壳加载页面渲染前设置 `color-scheme` 和 `body[data-ds-dark-theme]`。不含 HTTP 服务器的组合不受影响，插件树激活后，ThemeRuntime 与 ui-layout 仍分别是客户端状态和后续 DOM 更新的权威来源。

`src/styles/` 下有七张样式表，由 ui-theme 的动态客户端 entry 依次导入：`base.css`、`corner-shape.css`、`design-platform.css`、`metrics.css`、`scrollbar.css`、`gradient-shadow-text.css` 与 `shiki.css`。客户端 bundle 将其编译并注入为插件持有的全局样式，因此卸载与 HMR 会随 ui-theme 一同移除这些样式，而不会把主题 CSS 留在静态 Web 外壳中。`metrics.css` 提供客户端包共用的间距、安全区、圆角、触控目标、手机 Sheet 几何、compact 排版／图标角色以及有状态控件几何。有状态的手机控件必须保留可读的当前值文字，并使用统一设置 Sheet 语言，不得由功能包自行发明选择器外观。`scrollbar.css` 是 `--dsw-alias-scrollbar-*` token 的唯一消费方，必须排在声明这些 token 的 `design-platform.css` 之后。

滚动条重新绑定约定：`scrollbar.css` 在 `body` 上把 `--dsh-scrollbar-thumb` 与 `--dsh-scrollbar-thumb-hover` 绑定到 l1（基础表面）token，两条渲染路径都读取这一组变量。高层级表面（菜单、浮层、对话框）在自己的容器上设置 `--dsh-scrollbar-thumb: var(--dsw-alias-scrollbar-bg-l2)` 与 `--dsh-scrollbar-thumb-hover: var(--dsw-alias-scrollbar-hover-l2)`；一次重新绑定即可为引擎实际走的那条路径换色。这组变量的另一个合法目标是 `transparent`，即完全不绘制滑块——[ui-sidebar](../ui-sidebar/README.zh.md) 在指针不在栏内时就这样重新绑定自己的列。绑回 l1 那组不算重新绑定，它只是重述基础表面的默认值。WebKit 滚动条的宽度和高度均为 4px；`--dsh-scrollbar-width` 镜像其布局宽度，供需要与占布局宽度的滚动条对齐的表面使用——[ui-conversation](../ui-conversation/README.zh.md) 用它作为覆盖 composer 座位 `right` 偏移。卡片内部的 WebKit 滑块使用共享的 `--dsh-scrollbar-thumb-inset`，确保滚动条变窄后仍有可见的有色内芯。scrollbar-styles 规格会把这些值与消费者配对检查。

两条路径在构造上互斥。`scrollbar-width`／`scrollbar-color` 写在 `@supports not selector(::-webkit-scrollbar)` 之内，因为这两个属性中的任一个只要取非 `auto` 值，Chromium 与 Safari 就会丢弃该元素上的全部 `::-webkit-scrollbar*` 规则，`::-webkit-scrollbar-thumb:hover` 也在其中——若无条件地同时声明，`--dsh-scrollbar-thumb-hover` 在任何引擎上都不会被渲染。因此 Firefox 走标准属性，WebKit 系引擎走伪元素，hover token 只经由伪元素这条路径渲染。相关原理与实测计算值见[滚动条 Agent Note](../../../.agents/notes/implemented/bug-fix/2026-07-28-themed-scrollbars-and-reserved-gutter.zh.md)。

`corner-shape.css` 平滑每一个圆角：在 `@supports (corner-shape: superellipse(1.5))` 内定义 `--dsw-corner-shape`，并通过通用选择器应用到所有元素及其 `::before`／`::after`，因此不支持 `corner-shape` 的引擎保持圆弧角。全圆形状——`border-radius: 50%` 的圆与胶囊圆角——须在所属组件样式表里把 `corner-shape: round` 与其 radius 配对，因为超椭圆会使它们变形；corner-shape 样式表 spec 会在全部包样式表上强制这一配对（[圆角平滑 note](../../../.agents/notes/implemented/feature/2026-09-01-web-superellipse-corner-smoothing.zh.md)）。

`gradient-shadow-text.css` 拥有阴影刻度（`--dsw-shadow-lv*`）与 elevation token：`--dsw-elevation-stroke` 通过可重绑定的 `--dsw-elevation-stroke-color` 画出 0.5px 发丝描边，`--dsw-elevation-panel`／`--dsw-elevation-prominent`／`--dsw-elevation-soft`（composer 使用的更大模糊、更低透明度一档）在该描边之上叠两层极淡的柔光，因此悬浮表面设置 `border: 0`、不再携带占布局的轮廓；派生 token 逐元素重新声明，使表面对描边色的重绑定生效。扁平控件保留真实边框，但统一为 `0.5px solid` 发丝粗细；elevation 样式表 spec 会在全部包样式表上扫描这两条规则（[elevation note](../../../.agents/notes/implemented/feature/2026-09-01-web-elevation-stroke-shadows.zh.md)）。

## 设置权限与兼容性

外观控件显示账户偏好；项目策略可以强制当前界面使用浅色或深色方案。账户级 scope 在报告 `loading`、`writable: false` 或写入处于 `saving` 时禁用选择；项目和提供方限制会在行内显示，服务在取得可写账户视图前也会拒绝直接调用 `setTheme`。主题监听器同时支持 `addEventListener` 与旧版 `addListener` MediaQueryList 实现。设计样式表提供 `100vh` 视口回退，客户端可视视口测量就绪后覆盖该值；token-contract 测试会检查所有 `--ds-*` 与 `--dsw-*` 引用均有 CSS 声明，视口高度这一运行时变量是明确例外。

## 模型体验

无。主题服务管理浏览器偏好；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **第三方主题是表层，不是产品**：注册主题意味着覆盖同名别名变量；目前不会验证一组覆盖是否完整。
- **token 样式表是颜色值的唯一权威来源**：会有意不补入 cssdesign 中缺失的值（例如设计中的 #4176E6 标签页蓝色）；一律采用最接近的语义 token。设计负责人批准的新增值是例外：须在同一变更中以一个静态尺度层级与一个语义别名的形式进入（`--dsw-static-blue-900` / `--dsw-alias-label-primary-bluish`）。
