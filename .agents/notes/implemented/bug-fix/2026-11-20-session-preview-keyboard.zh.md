# Agent Note: 会话预览的键盘操作

Status: implemented

[English](2026-11-20-session-preview-keyboard.md) | 中文

## Problem

指针预览能读取并复制较长的会话标题。会话行无法获得键盘焦点，Escape 也无法关闭紧凑预览。

## Decision

[会话行](../../../../packages/client/ui-workspace/README.zh.md)可接收原生键盘焦点，Enter 或空格打开对应会话。标题可复制时，行获得键盘焦点会打开[共用预览](../../../../packages/client/ui-primitives/README.zh.md)。Tab 进入采用 portal 渲染的复制操作，再按 Tab 从该行在页面中的位置继续移动。Escape 关闭预览，当焦点在卡片内时将焦点还给会话行。

## Alternatives considered

**依赖卡片在页面末尾的 Tab 停靠点。** 卡片由 portal 渲染在文档末尾，与会话行及其其他操作分离。

## Consequences

键盘可以访问会话、完整标题和会话操作。指针预览继续使用原有的停留时间和跨越间距的宽限期。

## Verification

浏览器回放重命名会话夹具，用键盘进入复制操作，检查剪贴板写入成功提示，并验证 Escape 关闭和焦点恢复。回放也检查窄窗口和矮窗口中的指针预览可以触及。
