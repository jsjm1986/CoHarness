# Agent Note: 会话列表在区域上发布其基线生命周期

Status: implemented

[English](2026-11-04-workspace-list-baseline-notices.md) | 中文

## Problem

工作区浏览器用同一数据源渲染行与空态提示，但对背后的会话与工作区基线生命周期没有任何暴露。待决或失败的拉取与空列表无法区分，重连刷新没有状态落位，保留列表的失败也没有重试路径。因此浏览器端到端契约无法指认稳定的区域、加载状态、失败警报或恒定的底边。

## Decision

`WorkspaceBrowser` 从两个已发布的基线派生单一的 `listBaseline`(`loading | ready | error`)——`useWorkspaces` 的 state 加 `baselinesReady`，以及 `useCurrentSessions` 的 state——并把它连同 `data-workspace-list-region` 一起作为 `data-workspace-list-state` 发布到列表区域。每个 `SessionTree`/`FlatList` 把提示渲染进其 `role="tree"`：拉取待决时显示 `Loading…`；列表为空时显示带 `Retry` 按钮、键为 `list-feedback` 的 `Could not load the list` 警报；否则渲染行。

`[data-workspace-list-footer]` 落位在树下方保持挂载并持有隐藏占位，使区域底边在各状态间恒定；保留列表的失败在其中显露其警报。`Retry` 通过注入的 `retryLists` 只重拉失败的基线，并在提示隐藏前把焦点交还树。文档管理器的回收站头携带 `data-documents-trash-header` 以满足同一捕获契约。

## Alternatives considered

**为提示另建一套客户端状态机。** 它会重复管理器已发布的状态，并有偏离 `baselinesReady` 的风险。

**仅在失败时挂载 footer。** 保留列表几何契约要求 footer 矩形在错误前、中、后保持恒定。

**用 `hidden` 属性隐藏占位警报。** `display: none` 会塌掉预留高度；`visibility` 加 `aria-hidden` 既保留占位又把元素移出可访问性树，在渲染与非渲染测试环境中一致。

## Consequences

空树在首次拉取期间显示真实的加载落位，而不是闪现“暂无会话”；保留列表在失败条提供 `Retry` 的同时保住行、滚动与焦点。任一基线失败时 `data-workspace-list-state` 读作 `error`，任一拉取在途或待决时读作 `loading`，只有双双落定才读作 `ready`。

## Verification

浏览器端到端套件捕获区域属性、`list-failed`、`list-loading`、`list-empty`、`list-retained-error` 与 `baseline-failed` 的 aria 快照、重连-失败-重试全周期的恒定列表几何与焦点，以及回收站头快照。包级单元规格覆盖组装后的浏览器。
