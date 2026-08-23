# Agent Note: Shared media-query listeners

Status: implemented

[English](2026-08-24-shared-media-query-listeners.md) | 中文

## Problem

多个需要在 shell frame 外呈现的控件分别监听同一个断点，因此 UI 同时挂载时，一个浏览器查询可能拥有多个原生 `MediaQueryList` 监听器。

## Decision

`useMediaQuery` 按精确查询字符串维护模块级注册表。每个活跃查询只拥有一个 `MediaQueryList` 和一个原生 `change` 监听器，再把事件分发给各个 React 订阅者；最后一个订阅者离开时同时移除两者。`window.matchMedia` 实现发生变化时，注册表会把订阅者集合迁移到新条目，避免测试 realm 或浏览器 shim 保留过期列表。快照读取复用活跃列表；浏览器 API 不可用时仍返回 `false`。

## Alternatives considered

**每个 hook 保留一个 `MediaQueryList`。** 否决：重复的断点监听会增加对象和回调，却不会改善浏览器结果。

**把断点放入全局 viewport Context。** 否决：portal 内容位于 shell frame 外，frame 的响应式标记不等同于窗口媒体查询。

**增加通用 viewport 事件总线。** 否决：为了一个精确查询复用场景引入更宽的可变状态面。

## Consequences

挂载的控件现在共享原生断点工作，同时保留每个 hook 的 `useSyncExternalStore` 更新、查询切换、清理和 API 不可用回退。注册表只在存在活跃订阅者时保留浏览器对象，最后一次卸载后不会继续持有它们。覆盖测试包含多订阅者、最后卸载、查询替换以及 `matchMedia` 实现替换。
