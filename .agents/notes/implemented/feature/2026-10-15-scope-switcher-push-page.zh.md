# Agent Note: 空间切换器以推入页接管侧栏列

Status: implemented

[English](2026-10-15-scope-switcher-push-page.md) | 中文

## 问题

切换器的历代形态——浮层菜单、卡片内嵌抽屉、卡片中枢、手机手风琴——一直在它所在的列里切出一块次级表面。每一代都把次级表面楔在触发器与会话列表之间：中枢的卡片外饰与侧栏底色脱节，同一中枢在手机上则是被挤进 300px 抽屉的桌面语法。空间切换是单一任务，信息集小而固定——当前空间身份、名单、可见性暂存、管理入口——它要的是一个页面，而不是列内一块可伸缩的切片。

## 决策

两个宽表面都把切换器渲染为绝对定位的**推入页**：紧凑端边缘到边缘盖住整个抽屉，桌面端对界到浏览区，让列的品牌、新建会话控件、面板列表与底栏保持可见。`.root`（侧栏列）声明 `position: relative`，`SidebarRoot` 把 `.regionArea` 的盒几何发布为可继承的 `--dsh-sidebar-region-top`/`--dsh-sidebar-region-height` 自定义属性——在 layout effect 中测量，并由单个 ResizeObserver 挂在 flex:1 的区域座上保持实时（周边 chrome 变化都会使它重排）。768px 以下 `.scopePage` 保持 `inset: 0`；以上则从这些变量读取 `top`/`height`。触发器保留 tile + 名称 + 模式标记（仅非默认空间显示的状态点+文字），但下箭头换成右箭头并新增 `aria-controls={pageId}`——它揭示的是一个页面，不是菜单。

- **两级导航。** `pageView` 在 `root` 与 `visibility` 间切换；`pageNav`（`push`/`pop`）决定滑动方向。根页的可见性行推入第二级；返回按钮与 Escape 将其弹出，根页上的 Escape 关闭整页。关闭再开永远落在根级。
- **根页清单。** 页导航行（返回控件 + `scope.menuTitle`）、当前空间 hero（身份 tile、名称、模式/状态 meta）、管理组（新对话可见范围 › 带暂存值、邀请 › 带待处理角标、项目设置 ›），以及全部空间组（个人 + 项目行，带身份 tile，选中项尾部勾，只读/维护标 caption 值）。项目超过四个时渲染名单搜索；注入 `project:create` 时新建入口落在页脚。
- **语义跟表面走。** 页面是有标签的 `role="group"`，行是普通按钮，选中空间带 `aria-current`。空间行切换并关闭；可见性行暂存 `stagedVisibility` 但不关闭——暂存的偏好不是一次选中。
- **`Menu` 只保留轨道路径**（`!wide`），不变：portalled 浮层列表、测宽、完整条目集。弹窗仍 portal 到 `document.body`，层叠在页面之上。
- 身份 tile 语法原样继承：`tileGlyph`/`tileTone` 行、代理对安全的首字、维护盾 tile、圆形个人空间 tile。

## 已考虑的替代方案

**保留卡片中枢 / 文档流内嵌面板。** 设计评审否决：卡片表面始终无法与列底色调和，而面板高度上限恰好压住最占地方的入口。手风琴变体在抽屉列内有同样的冲突。

**触发器上方的锚定浮层（Slack 式）。** 否决：它重新引入脱离主体的浮层，只在桌面成立，名单被浮层高度封顶——手机端没有对应表面，两端会再次分叉。

**常驻空间栏（Discord 式图标列）。** 否决：为一个间歇使用的控件永久压缩会话列表宽度，而且复制了页面已分组的管理入口。

## 后果

- `Menu` 不再持有宽路径：两个宽表面上都没有 `menu`/`menuitem` 角色、没有 `ResizeObserver` 测宽、没有 portalled 列表。测试必须查页面行（`group` 内的按钮），不能查 menuitem；轨道保留菜单角色。
- `.root` 现在是包含块——未来列内绝对定位内容都以它为界；区域几何变量是侧栏壳层持有的契约，任何列级浮层都可读取。测量契约住在 `SidebarRoot`，消费方只读 CSS。
- 页面在桌面端打开时只盖住会话浏览区——频道行、品牌与触发器本身保持可见，页面读作区域内容换页而非模态接管。紧凑端仍盖住抽屉整列，包括底栏。
- 可见性 `menuitem` id 只存在于轨道路径；暂存值出现在根页可见性行的值位与二级页的勾选项上。
- 取代已归档的[空间中枢接管](../../archived/feature/2026-10-13-scope-hub-sidebar-takeover.md)与[卡片内嵌抽屉](../../archived/feature/2026-10-13-scope-switcher-in-card-drawer.md)；轨道的测宽浮层列表仍由[宽度自适应面板菜单](2026-10-03-scope-control-panel-menu.zh.md)描述。

## 测试

`components.client.spec.tsx` 断言两个宽表面上的推入页：触发器揭示语义（`aria-expanded`/`aria-controls`）、根页清单（hero、管理行、角标）、可见性推入/弹出且暂存不关闭、Escape 层级行为、空间行切换并关闭、轨道 `Menu` 保留且无重复触发器。`scope-control-styles.client.spec.ts` 钉住页面几何（紧凑端 `inset: 0`、768px 以上的 `--dsh-sidebar-region-*` 边界、推入/弹出关键帧、reduced-motion 回退）与行/hero/分组语法。`SidebarRoot` 快照记录已发布的区域变量。聚焦套件通过（5 个文件 76 项），`tsc -b packages/client/ui-collaboration/tsconfig.json` 干净。
