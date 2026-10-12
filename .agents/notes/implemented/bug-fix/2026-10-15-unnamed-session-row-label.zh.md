# Agent Note：未命名会话行本地化其标签而非显示目录名

状态：已实现

[English](2026-10-15-unnamed-session-row-label.md) | 中文

## 问题

工作区树的 `sessionTitle` 读取 `SessionSummary.displayTitle`——该宿主侧标签以工作区 basename、继而会话 id 兜底。没有存储标题的历史会话因此把目录名当成标题渲染，本地标题搜索也会命中那个目录名。上游修复是 `bcf0ba45cb0` 及其重命名入口跟进 `a4ac7e9eb36`；本地渲染各面（`session.untitled` 词典、行与搜索结果标签、空草稿重命名、hover 复制抑制）早已就位——`sessionTitle` 是仅剩的兜底标签读取方。

## 决策

`sessionTitle` 现在产出 `session.title?.trim() ?? ''`——持久标题或空串。渲染器拥有兜底：blank 行显示 `session.new`，标题为空的非 blank 行在树与搜索结果列表中显示 `session.untitled`。行标题搜索由此只命中真实存储标题，绝不命中目录名。`SessionRowOwnerProps.displayTitle` 保持其契约——持久标题或空——因为 slot 属主（重命名、派生、归档对话框）必须看到耐久值而非本地化呈现标签。

## 备选方案

**让宿主的 `displayTitle` 不再兜底。** basename 兜底正是 header、workbench 工具栏、归档区块与 `AppFrame` 窗口标题对未命名会话仍有可读标签的原因；这些面有意保留宿主标签。在线协议层移除兜底会把所有这些面变成空白。

**在 `sessionTitle` 内本地化。** 标题搜索消费同一 helper，把本地化标签拿去匹配用户查询既错误又随 locale 漂移；空标题才是诚实的投影，呈现标签留在渲染边界。

## 影响

未命名历史行在两种语言下均显示未命名/Untitled；重命名入口（双击与 `session.rename` 快捷键）对它们打开空草稿而非预填目录名；未存标题时复制行标题不复制任何内容。线协议 `displayTitle` 不变——客户端其余标题消费方保持既有标签。

## 验证

`tree.client.spec.ts` 断言未命名 summary（无 `title`、displayTitle 为目录名）派生出空行标题，其 `summary()` fixture 同时种 `title` 与 `displayTitle`，使搜索命中用例走存储标题路径。`rows.client.spec.tsx` 与 `shortcuts.client.spec.ts` 已覆盖本地化标签与空重命名草稿。`workspace-browser` fixture 把 `displayTitle` 覆写映射为存储 `title`，使装配视图继续显示具名行。

## 关联

- [2026-07-21 日志承载的会话标题](../feature/2026-07-21-log-backed-session-titles.zh.md)——本改动渲染所依据的标题投影与 `displayTitle` 线协议。
