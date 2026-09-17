# Agent Note：窄分栏 composer 改用裸图标座 + 悬停圆

状态：已实现

[English](2026-09-18-composer-narrow-pane-bare-icons.md) | 中文

## 问题

在 480px 容器档位上，composer 把权限和模型 chip 折叠为"图标 + 下三角"的座，而附件、文档、命令座仍保留填充圆底。在工作台分栏约 360px 的最小宽度里，这一行依旧溢出；始终填充的圆底也消耗了窄分栏本就没有的视觉重量。

## 决策

Composer 的 `.row` 直接 `nowrap`：任意宽度都不会折成第二行，降级因此可以连续进行——chip 标签随可用宽度流式截断（flex `min-width: 0` + 省略号），扩展项在自己的轨道内被裁剪，而在 `@container (max-width: 480px)`——共享的窄面板档位——下，每个 composer 控件降级为 28px 裸座：权限和模型触发器只留字形、去掉标签与下三角，附件/文档/命令座变为透明。悬停时在字形背后绘制一个 24px 圆——chip 上是 `triggerGlyph` 圆，`.add` 上是内缩 `::before`——静置行保持扁平，可点提示只在指针下出现。容器宽度低于 340px 时上下文表整体隐藏，因为它的明细已经存在于弹层和 composer 页脚统计里，不必再为一行挤不下的空间竞争。compact 手机档不变：`[data-viewport='compact']` 恢复 40px 填充座（360px 以下 36px）、保持上下文表可见，并清掉悬停伪元素，使触击残留的悬停态不会重绘圆底。

## 备选方案

**折叠后的图标旁保留下三角。** 否决：下三角每个 chip 约多花 12px，且在这个密度下看起来像第二个字形；触发器仍能打开菜单或 sheet，`title`/`aria-label` 仍承载完整标识。

**溢出时折到第二行。** 否决，理由同容器降级笔记否决固定两行：分栏变窄就要付出纵向空间，而隐藏上下文表零成本——它的数据在卡片其它位置已有。

**compact 手机档也用 28px 裸座。** 否决：compact 上触控目标保持 40px/36px 族；裸座只存在于由指针瞄准的场合。

## 影响

composer 在工作台分栏最小宽度下保持单行，更窄时仅通过隐藏上下文表继续降级（容器宽 340px 以下）。两个 chip 触发器保留无障碍名称、标题、菜单和设置 sheet 入口；上下文表弹层在其仍渲染处保持可达。本笔记细化[按容器宽度降级的 composer 行](2026-09-17-composer-row-container-degradation.zh.md)的座处理——同一个匿名容器与共享档位——并不触及[移动端 composer 单行图标工具行](2026-09-18-composer-single-icon-row.zh.md)所拥有的 compact 档。

## 验证

`model-select-styles` 与 `compact-chrome-styles` 对照样式表文本固定 28px 座、24px 悬停圆、下三角移除和 compact 恢复项；同一规范断言上下文表的 340px 容器隐藏及 compact 豁免。在构建产物上经浏览器核验：360px 工作台分栏呈现单行 28px 高工具行、裸图标座、无上下文表；800px 分栏保留带标签 chip；悬停计算样式为内缩圆。`composer-model-mobile.e2e.ts` 在 compact 档上原样通过。
