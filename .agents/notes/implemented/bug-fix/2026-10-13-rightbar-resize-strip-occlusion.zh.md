# Agent Note: Details resize strip rides the panel border, above dock and scrim layers

Status: implemented

[English](2026-10-13-rightbar-resize-strip-occlusion.md) | 中文

## Problem

Inset 卡片改版（`b8b1715df87`）给 `.detailsCol` 加了 8px 的 frame 内缩（`right: var(--dsw-space-2)`），使停靠右侧面板的左缘移到把手所对齐的轨道边再向左 8px。于是 8px 把手整条落在面板盒内部——dockkit 单元（`z-index: 10`，`.tabHost` 上 `pointer-events: auto`）在绘制和命中上都压过把手（`z-index: 2`），每次 pointerdown 都落在面板内容上，拖拽永不触发；悬停显示的胶囊指示条也被面板不透明背景遮住。同一笔账还让 medium 档的 overlay 面板压在自己的 scrim 之下（14 对 10）：打开的面板被压暗、任意点击都触发关闭。jsdom 测试直接把 pointer 事件派发到把手元素，两个回归都无法在单测里观测。

## Decision

把手现在对齐用户真正看到和抓取的缝——面板的左缘——而不是轨道边。非 compact 模式下 `.handle[data-side='details']` 平移 `calc(0px - var(--dsw-space-2)) 0`，镜像 `.detailsCol` 的内缩 token，偏移不会漂移。`.handle` 升到 `z-index: 15`，高于 dock 层（10）和打开的 scrim（14），portalled overlay（20）与 dockkit 浮层（60）仍在它之上；胶囊因此绘制在卡片边缘。`.frame[data-viewport='medium'] .detailsCol` 获得 `z-index: 15`，把整个 overlay 面板子树抬到自己的 scrim 之上；compact 不需要——fullscreen 呈现已把 dock 层提到 40。

## Verification

`app-frame-styles.client.spec.ts` 以词法方式断言契约：details 把手的 translate 镜像内缩 token、把手 z-index（15）高于 scrim（14）、medium 档 `.detailsCol` 抬升规则存在。用编译产物里的 CSS（从构建后的 `client.js` 提取）在 Chromium 里做真实 `elementFromPoint` 命中测试：修复前把手区域在 expanded 命中 `.tabHost`、medium 全命中 scrim；修复后边界命中把手、面板内部命中内容、空白处仍是 scrim，悬停胶囊正常显示。

## Alternatives considered

**把把手挪进两卡片之间的 gutter。** 否决：那样不再压面板、确实不需要动 z-index，但指示条会漂在两卡之间，而不是骑在用户预期抓取的边界上。

**在 `AppFrame.tsx` 里算偏移。** 否决：那会把像素内缩硬编码进 JS，而内缩本是 stylesheet 里的 token；CSS `translate` 保持单一事实来源。

## Consequences

- details 拖拽指示条在 expanded/wide 重新可点可见；medium overlay 面板在自己的 scrim 之上可交互。
- `DragHandle` 的 `left` prop 仍是轨道边；面板边界的校正在 stylesheet，由 `data-side='details'` 选择。
- `.detailsCol` 内缩日后改动会自动带动把手位置；改动 scrim 或 dock 层级数字时必须保持 `14 < handle < 20`。
