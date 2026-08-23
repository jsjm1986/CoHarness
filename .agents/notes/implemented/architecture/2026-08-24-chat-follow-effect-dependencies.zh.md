# Agent Note: Flow-gated chat follow layout effect

Status: implemented

[English](2026-08-24-chat-follow-effect-dependencies.md) | 中文

## Problem

Chat 视图的布局 effect 负责打开恢复、前置分页锚定和贴底跟随决策。每次渲染都运行它，会让无关的 chrome 状态和阅读位置更新在长会话挂载时重复执行布局工作。

## Decision

布局 effect 只在 flow 输入变化时运行：打开状态、首尾节点身份、末节点类型、待处理 steering 身份、flow 签名或滚动记忆回调。仅尺寸变化仍由现有 `ResizeObserver` 负责，滚动监听器继续独立更新阅读位置。effect 仍处理首次恢复、前置锚定、尾部用户／steering 到达和已贴底的 flow 增长；本改动不移除或虚拟化 Chat 节点。

## Alternatives considered

**保留每次渲染运行的布局 effect。** 否决：阅读位置状态和无关 overlay 可以在 flow 输入未变化时触发相同几何工作。

**在本次改动中引入 Chat 虚拟化。** 否决：可变 Markdown、工具、图片、流式内容、inspect 和前置分页几何需要独立实验与更广泛的浏览器契约。

**只在滚动和流事件处理器中执行跟随决策。** 否决：首次挂载、tab 恢复和 React 提交的前置分页仍需要提交后的布局阶段。

## Consequences

无关的 Chat 渲染不会再次执行 flow 布局决策，同时现有滚动、前置分页、流式和 tab 恢复行为继续由 ChatView 单测、滚动契约与连续对话浏览器测试以及高基数性能套件覆盖。基于尺寸的贴底跟随和语义锚定模型保持不变。未来的 Chat 虚拟化必须保留这种分离，不能把尺寸观察并入 flow effect。
