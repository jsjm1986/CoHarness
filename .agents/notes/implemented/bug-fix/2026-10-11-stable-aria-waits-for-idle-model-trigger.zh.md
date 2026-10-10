# Agent Note: 稳定 aria 快照等待模型触发按钮空闲

Status: implemented

[English](2026-10-11-stable-aria-waits-for-idle-model-trigger.md) | 中文

## 问题

`captureStableAria` 以连续两次归一化 aria 快照相等判定区域已落定。模型触发按钮的加载态呈现静止的 "Loading model…" 文案，而 `aria-busy` 不出现在 aria 快照里，因此目录仍在加载时拍下的区域也能通过相等检查——golden 期望的是落定后的模型名，CI 于是非确定性失败（`markdown-images.e2e.ts` 在本该出现 `DeepSeek-V4-Flash` 的位置出现了 `Loading model…`）。约四十个 golden 拍到该按钮，逐个 spec 加等待会重复同一个隐患。

## 决定

触发按钮以 `aria-busy` 上报加载态——与其菜单已有的同一表达式（`state.status === 'loading' || busy`）——并且 `captureStableAria` 要求每轮稳定判定都确认被拍区域内不存在 `[data-model-trigger][aria-busy="true"]`，才接受快照相等。

## 曾考虑的替代方案

**在稳定轮询前等待一次。** 否决：触发按钮可能在该等待之后挂载并在两次快照间保持加载态，留下导致 flake 的残余窗口。

**匹配本地化的占位文案。** 否决：文案随界面语言变化，且会把 UI 字符串硬编码进共享快照基建。

**区域内任何 `aria-busy` 存在即拒绝。** 否决：常驻的 busy 元素（例如设计上就标 busy 的 `role="status"` 面板）可能合法出现在 golden 中，会让对应 spec 卡死。

**保留逐个 spec 的 `waitFor`。** 否决：四十余个 golden 拍同一个触发按钮；共享 helper 是该落定条件的唯一归属。

## 影响

在模型目录加载期间执行的快照最多等待十秒；真正卡住的加载以 `aria snapshot did not stabilize` 报出，点明所等待的状态而不是写下非确定性 diff。触发按钮的 `aria-busy` 现在也对辅助技术如实上报加载，与菜单一致。

## 验证

`model-select.client.spec.tsx` 断言加载中触发按钮的 `aria-busy`。`markdown-images`、`math-rendering`、`reference-composer`、`workspace-history-entry` 四个 e2e——各自的 golden 都命名了落定后的模型——在构建产物下以更严格的落定条件通过。

## 相关

- [Floor geometry owns at-bottom](2026-09-16-floor-geometry-owns-at-bottom.zh.md) — 记录了当所拍状态是终态时等待落定为何是错误修法；此处加载态是暂态。
