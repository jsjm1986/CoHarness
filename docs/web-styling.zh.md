# Web UI 样式参考

[English](web-styling.md) | 中文

本文规定浏览器客户端包的样式职责归属与组件规则。当前 token 值位于 [`packages/client/ui-theme/src/styles/`](../packages/client/ui-theme/src/styles/)；本文不重复这份由源码生成的清单。

## 职责归属

[`ui-theme`](../packages/client/ui-theme/README.zh.md) 负责 `--dsw-*` 静态色阶、语义别名、排版、动效、渐变、阴影、滚动条样式以及明暗主题偏好。[`ui-layout`](../packages/client/ui-layout/README.zh.md) 将解析后的主题快照应用到文档。功能包使用语义别名，不得另行定义全局主题。

全局样式表归 `ui-theme/src/styles/` 所有。组件样式以 CSS Modules 形式放在组件旁。当某个值属于该组件的布局或呈现约定时，组件可以定义局部自定义属性；共享颜色、排版、层级和动效属于主题包。

## 组件规则

- 使用 CSS Modules 和 `clsx`；不得添加组件库或 Tailwind。
- 功能组件使用 `--dsw-alias-*` 语义 token。不得复制静态色板值或在其中写入颜色字面量。
- 功能组件 CSS 不得包含主题选择器。明暗主题覆盖属于主题所有方。
- 字体大小必须与行高配对；已有角色匹配时使用主题排版变量。
- 当组件约定要求保留列结构时，源码文本、终端输出和 diff 行不得换行；使用共享滚动条样式，不得定义组件专用滚动条选择器。
- 呈现规则写在 CSS 中。React 内联样式可以传递组件局部自定义属性值，但不得编码主题分支。
- 添加过渡动画或仅悬停可见的控件时，保留清晰可见的键盘焦点和减少动态效果行为。

## 响应式布局

外壳会把当前视口档位以 `data-viewport` 标记在框架根元素上：768px 以下为 `compact`，1024px 以下为 `medium`，1440px 以下为 `expanded`，自此往上为 `wide`，阈值见 [`viewport.ts`](../packages/client/ui-layout/src/client/viewport.ts)。低于短高度阈值的 compact 框架还会携带 `data-viewport-short`；该标记只用于次级纵向密度决策。框架内的组件 CSS 以这些标记做分支（`[data-viewport='compact'] &`），而不是测量窗口或硬编码宽度断点。

需要响应自身宽度而非整个框架的面板，在其根元素声明 `container-type: inline-size`，并以匿名容器查询（`@container (max-width: …)`）在共享档位宽度 480、560、720 上分支。CSS Modules 会按模块对 `container-name` 做哈希，因此跨模块查询保持匿名；绝不在包含非自有 `position: fixed` 内容的祖先上声明 `container-type`，因为 layout containment 会改变 fixed 元素的包含块。

间距与圆角取自度量 token（`--dsw-space-*`、`--dsw-radius-*`），设备安全区取自 `--dsw-safe-*`（metrics.css）。在粗指针设备上，悬停显现的控件需要 `@media (pointer: coarse)` 常显回退，交互目标保持至少 `--dsw-touch-target`；仅悬停的提示归入 `@media (hover: hover)`。框架内外壳在 `[data-viewport='compact']` 下同样放大这些目标，因为部分手机 WebView 会报 `pointer: fine`。portal 渲染的浮层看不到框架标记——它们在 JS 里用 ui-primitives 的 `useMediaQuery` 按相同阈值分支，并在 `@media (max-width: 767px)` 下放大同样的目标。框架内侧栏脚注把 `sidebar.footer.action` 叠成 Settings 几何的通栏行，叠在 Settings 上方；收起的 rail 把同一组占用者竖排成 36px 圆。

`metrics.css` 还定义了 compact 排版角色（`--dsw-mobile-font-*`）和图标视觉尺寸。手机主要内容使用 14/22 或更大的字号，12/18 只用于元数据；44px 触控目标与图标的视觉尺寸分开控制。信息层级复杂的页面可以使用手机专属 presenter 或卡片／列表投影，不得把桌面表格单纯缩小到刚好塞进屏幕。

手机底部 Sheet 共享 `--dsw-mobile-sheet-*` 度量 token，统一边缘、安全区底部、圆角和默认高度。`ui-primitives` 统一持有 `MobileSheetBackdrop` 遮罩（包括模糊、层级和减弱动效），`Modal` 统一持有焦点循环；呈现器可以收窄内容上限或增加手机专属返回行，但不得改变共同的放置位置和触控几何。

`Menu` 的主列表在 768px 以下使用同一套 Sheet 几何，即使桌面放置方式是相对锚点定位；子菜单内容仍在父行下方内联展开。

## 变更系统

在所属 `ui-theme` 样式表中添加或修改共享 token，然后在功能包中使用其语义别名。公共样式约定发生变化时，更新所属包的参考文档。视觉行为遵循[测试策略](testing.zh.md)；[样式系统 Agent Note](../.agents/notes/implemented/process/2026-07-19-web-styling-system.zh.md) 记录框架依据。
