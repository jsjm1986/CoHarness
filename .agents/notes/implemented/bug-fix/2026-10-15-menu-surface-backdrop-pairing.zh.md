# Agent Note: 抬升菜单表面须成对声明填充与磨砂

Status: implemented

[English](2026-10-15-menu-surface-backdrop-pairing.md) | 中文

## Problem

`--dsw-specific-menu` 解析到共享半透明填充（浅色 58%、暗色 45%）——[菜单材质表面](../feature/2026-10-15-menu-material-surface-and-keyboard-guards.zh.md)将它与 `backdrop-filter: var(--dsw-menu-backdrop-filter)` 成对绘制，blur(40px) + saturate(150%) 这一半才把"透字"变成"磨砂"。四个自建浮层只拿了填充令牌、漏了磨砂，会话文字以 42–55% 可见度透上来：子智能体谱系菜单、任务列表菜单、turn 统计面板、消息反馈便签面板。它们都是 `position: fixed` portal 压在会话内容之上——最糟糕的底衬——每个都复现为文字叠文字、不可读。

## Decision

每个受影响面补回缺失的一行：`background: var(--dsw-specific-menu)` 旁加 `backdrop-filter: var(--dsw-menu-backdrop-filter)`。这些面自绘 chrome 而不经 `MenuSurface` 渲染——谱系菜单是带树线的 disclosure 树，统计面板与便签面板是内容面板，任务菜单带实时行 chrome——所以修的是声明配对，不是迁到共享材质。任务菜单内两个徽章元素把填充当颜色用是有意的，保持原样。

新增仓库门槛 `verify-menu-surface-backdrop`，为未来所有表面强制配对：`packages/client` 下任一规则同时声明 `background: var(--dsw-specific-menu)`（或 `var(--dsw-menu-surface-fill)`）与抬升阴影（`box-shadow: var(--dsw-elevation-*)` 或 `--dsw-elevation-stroke-color`）时，必须同块声明 `backdrop-filter`。只有填充、没有抬升的元素——徽章豁免——允许。门槛挂在 `consumerSurfaceGates`，与其他客户端表面检查同组。

## Alternatives considered

**把四个面迁到 `MenuSurface`。** 本次拒绝：四面中有三面根本不是菜单（disclosure 树、统计面板、便签编辑器），任务菜单的实时行 chrome 早于材质契约。配对声明恢复可读性而不重构行内容；逐面迁移材质仍可进行。

**改不透明填充。** 拒绝：会分叉表面语言——另外五处浮层都保持磨砂配方，半透明是系统语言，不是缺陷。

## Consequences

- 任何要用菜单填充的新浮层必须在同一规则内声明 `backdrop-filter`，否则门槛失败；完全不使用 `--dsw-specific-menu` 的不透明面板不受影响。
- 配对是配方契约而非令牌契约——主题保持两半分离，表面仍可通过换填充显式退出。

## Testing

`scripts/verify-menu-surface-backdrop.spec.ts` 断言仓库清单干净、对两种填充写法的缺失磨砂 fixture 检出违规、豁免无抬升的填充元素。修复后门槛在整个客户端语料上零违规。
