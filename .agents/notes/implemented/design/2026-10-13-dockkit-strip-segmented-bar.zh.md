# Agent Note: Dock 标签条采用分段条语言，面板正确裁剪圆角

Status: implemented

[English](2026-10-13-dockkit-strip-segmented-bar.md) | 中文

## Problem

`b8b1715df87`（内嵌卡片改版）重做了框架与会话表面，但没有触及 `ui-dockkit` 和 `ui-sidebar-right`，右侧栏停留在旧的编辑器标签语言——裸芯片、竖线槽位分隔符、`markdown-tag` 平涂活跃填充——而会话头和左侧栏已换成分段条加浮起滑块 pill。条带自身也不绘制底部分隔线，且内嵌卡片的圆角是无效几何：每个停靠 `.tabHost` 用不透明的方形 `bg-base` 填充盖住 `.panel` 的 `radius-window` 圆角，而 `.panel` 又必须保持不裁剪，以便 `position: fixed` 的浮动面板和滑出动画能够逃逸。

## Decision

`.stripTabs` 变为分段轨道（`interactive-bg-hover` 填充、`radius-card`、3px 内边距），包裹 24px 芯片并采用分段条字体（`radius-control`、500 字重、-0.01em）。选中芯片——以及面板唯一不可关闭的 label（它仍然标识正在显示的内容）——佩戴浮起 pill（`bg-raised`、`elevation-control`、`border-l3` 描边），替代 tag 平涂。槽位收窄为 4px 间隔、只承载拖拽插入光标；竖线分隔符与贴边时代的 column-0 左边线一并移除。`.tabHostHeader` 统一绘制头部细线（`border-bottom: 0.5px border-l3`），停靠条带与浮动头共用。条带的纵向 inset 与 `inline-start` 一样成为发布变量——`--dsh-dockkit-strip-block`（条带总高，默认 38）与 `--dsh-dockkit-strip-block-start`（内容上缘，默认 8）——让相邻更高头部的宿主可以拉齐条带而不必分叉样式表。右侧栏发布会话头的 52px（space-3 + 32px titleRow + space-2），内容上缘取 space-3：两条头部细线落在同一条线上，芯片轨道与会话头共享同一上缘节奏。

芯片内部：关闭钮缩至 18px 圆（12px 字形、3px 内缩），嵌入方的前导图标统一为 14px——图标、文字、关闭在 24px 内共享同一视觉配重。分栏控件的手绘描边方框换成图标集新增的 `IconSplitPanesOutline16`（Lucide `Columns2`），笔画粗细与圆角和条尾控件一致。标签菜单项改为 `radius-md`。

圆角裁剪移到 `.panelBody`（`overflow: clip; border-radius: inherit`，仅 push 形态）：overflow 不会捕获 fixed 后代，浮层照常逃逸，而停靠 host 被裁进卡片圆角。fullscreen 保持直角。Guide 胶囊改用 `radius-full` 替代硬编码 24px。

## Verification

`strip-styles.client.spec.ts` 针对磁盘上的样式表词法断言契约：轨道、38px/30px 度量、分段字体、浮起 pill（且 `.tabActive` 不再有 `markdown-tag`）、仅含光标的槽位、头部细线。聚焦测试通过（ui-dockkit 与 ui-sidebar-right 共 530 个用例），编译样式表在 Chromium 中渲染确认了轨道、pill、细线与圆角裁剪。

## Consequences

- 所有 dockkit 消费方——右侧栏、工作台面板、浮动窗口头——统一渲染为分段条语言；这次样式改动刻意是整个表面的。
- 关闭滑出动画现在在卡片右缘处裁剪，不再溢出 8px。
- `.tabActive:hover` 保持浮起填充（选中分段悬停不变暗）；`.tab.floatTitle` 与 `.tabQuiet` 保留各自的悬停豁免。
