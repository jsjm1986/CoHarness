# Agent Note: 设置浮层 portal 与 compact 全屏页

Status: implemented

[English](2026-08-19-settings-overlay-portal.md) | 中文

## Problem

compact 视口下设置浮层是侧栏抽屉的 `position: fixed` 后代。抽屉使用 `transform` 与 `overflow: hidden`，宽度为 `min(85%, 320px)`，因此浮层的包含块是抽屉而不是视口。再叠加纵向 flex 面板的内容列缺少 `min-height: 0`，模型列表被裁切，`.options { overflow-y: auto }` 拿不到有界高度。手机用户无法滚到最后一条组织模型。桌面 800px 双栏稿被挤进该抽屉：36px 标签、28px 关闭、nowrap 模型行。

## Decision

`SettingsPanel` portal 到 `document.body`，并在其生命周期内把 `#root` 设为 inert，关闭时恢复先前的 inert 标志（OnboardingSurface / Modal 先例）。compact（max-width 767px；浮层看不到 `data-viewport`，因此用媒体查询）是全视口页，高度用 `--dsw-viewport-height` / `100dvh` 与 `--dsw-safe-*`。CSS grid 加上 `.nav` / `.content` 的 `display: contents` 让标题与关闭同一行、分区标签第二行、仅 `.options` 滚动。标签单元格与粗指针关闭控件使用 `--dsw-touch-target`。桌面仍是 800px 双栏卡片。各分区包自有 compact 叠行（模型名称/id、通用行、插件标签、库存搜索、预设卡片），不导入外壳。

相关：[响应式外壳视口模式](2026-08-14-responsive-shell-viewport-modes.md)。

## Alternatives considered

**只给 `.options` 加 `min-height: 0` / `overflow-y: auto`。** 被拒：浮层仍困在抽屉里，最宽 320px，旁边还能看到对话区。

**复用 primitives `Modal` 的底部抽屉。** 被拒：Modal 是短对话框（文档管理）。设置是长目的地；底部抽屉仍会裁切长组织目录。Modal 的 compact 几何保持底部抽屉。

**iOS 式先点分区再 push 子页。** 本轮被拒：三到四个分区用横向标签条即可，不必再加一层导航。

**打开设置时自动关掉 compact 抽屉。** 被拒：用户从侧栏进入设置，关掉后应回到侧栏。portal 后的浮层盖住视口，不必把 Settings 接到 AppFrame。

## Consequences

compact 设置铺满可视视口，并在 `.options` 内滚动。外观三块保持一行；四个分区标签在 390px 条内不被裁切（标签行设置 `overflow-y: hidden`，否则 `overflow-x: auto` 会算出第二条纵向滚动）。嵌套的删除/目录对话框已经通过 Modal portal，叠在上方。compact 抽屉的 `transform` 不再裁切该浮层。`ui-settings-general` 为 `createPortal` 把 `react-dom` 列为 peer。`display: contents` 的外壳可能让 compact 无障碍树比桌面更扁；compact e2e 金标钉住该树。
