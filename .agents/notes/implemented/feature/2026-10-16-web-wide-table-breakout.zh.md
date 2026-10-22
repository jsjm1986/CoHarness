# Agent Note: 宽 Markdown 表格突破至 transcript 全宽

Status: implemented

[English](2026-10-16-web-wide-table-breakout.md) | 中文

## 问题

四列及以上的 Markdown 表格保持自然宽度并在包装层内滚动，但包装层本身被限制在 748px 消息列宽内，即使 transcript 两侧各有数百像素未用空间。deepsuite chat 则让这类表格横跨整个 transcript，同时让表格内容左缘与消息列对齐；本 fork 已渲染 `md-table-wide` 钩子，却没有消费它的 breakout 规则，宽表格因此在列边界被裁切。

## 决策

ChatView 的 `.scroll` 元素是 transcript 的匿名 inline-size query container，`md-table-wide` 包装层内的 `100cqw` 因此解析为 transcript 内容宽度——这是 deepsuite chat 用 JS 测量的 `--dsl-virtual-list-width` 的 CSS 替身。AssistantMarkdown 把 `--dsh-table-spare` 计算为超出 `--dsh-chat-content-width` 部分的一半并钳制到零，令包装层加宽 `spare + lead`，再用等量的负外边距与前导内边距抵消扩展，使表格仍从消息列左缘开始。百分比相对包装层的包含块解析，嵌在列表里的表格也能到达相同的 transcript 边缘。

可见的 `table` 元素——而非透明的全宽包装层或其对齐内边距——提升到 Conversation 宽度拖拽条之上，只有实际延伸进沟槽的内容才占有指针（[宽度拖拽条分层](../bug-fix/2026-10-16-transcript-width-handle-layering.zh.md)）。滚动包装层在悬停或键盘聚焦时通过切换 `overflow-x` 本身显现横向滚动条（Chromium 不会重绘状态条件化的滚动条样式）；用 `scroll` 而非 `auto` 让适配列宽的表格也预留条高，使下方行在悬停与聚焦切换间保持不动。

## 已考虑的替代方案

**用 ResizeObserver 发布 transcript 宽度。** deepsuite 在 JavaScript 中测量虚拟列表；在此以命令式变量实现会重复引擎已为 container query 完成的布局工作，并在动画期间晚一帧发布。

**所有表格都限制在消息列内。** 保持了列的纯粹性，却把 transcript 的空余宽度浪费在恰好最需要它的内容上——多列表格要么把单元格压到不可读，要么只在一小撮可用空间里滚动。

**不做前导对齐的 breakout。** 对称扩展包装层而不做内边距补偿会让表格内容起点越过消息列左缘，破坏读者视线追踪的纵向节奏。

## 后果

`md-table-wide` 在 AssistantMarkdown 的 `.body` 承载 transcript 的任何位置都成为生效的 breakout 钩子；同一 Markdown 渲染器的其他消费者（workbench 面板、任务视图）保持列内滚动，因为 breakout 规则限定在 Chat 样式表内。transcript 内任何 `cqw` 单位都相对 `.scroll` 解析，包括渲染器 30cqw 的表格单元格上限，因此它们是 transcript 相对而非视口相对。低于消息列宽时 spare 钳制到零、包装层保持列宽，compact 与 medium 视口不会产生横向位移。

`markdown-wide-table` 浏览器场景固定了填充/滚动/breakout 关系、前导内边距对齐、键盘滚动、悬停显现的滚动条、适配表格的静止性、可见内容命中测试以及页面缩放与高 DPI 等价性，覆盖 1680/1100/640 视口扫掠；其布局等待读取 frame 的视口类别，因为 compact 会替换三列轨道模板。单元规格已覆盖渲染器的列数钩子；golden 只记录关系与布尔值，不记录像素。
