# Agent Note: 共享移动端顶栏契约并为手机投影轨迹事件

Status: implemented

[English](2026-08-25-mobile-header-and-trajectory-presenter.md) | 中文

## 问题

compact 对话使用面向桌面的标题栏和轨迹表格，低频工具占用整行，手机视口难以扫描事件内容。若只增加一次性的 CSS 覆盖，后续会话工具和轨迹字段仍没有稳定的放置契约。

## 决策

布局层拥有 session-scoped 的 `shell.mobile.header.actions` slot，并通过 conversation owner props 传递解析后的 compact 模式。AppFrame 在 44px 手机顶栏中渲染该 slot，桌面工具继续使用原有 session header slot。Session log 导出在桌面和移动 presenter 之间共享同一个 controller 与 dialog。

轨迹继续使用一份 record projection、选择 controller、历史分页器、搜索索引和虚拟行身份。桌面渲染现有 table；compact 渲染 `TrajectoryMobileFeed`，使用固定手机行高、主信息行、元数据行和相同的 record/request 选择回调。移动详情复用现有 inspector 字段并使用底部 Sheet，桌面继续使用可调整宽度的侧栏面板。

共享移动指标由 `ui-theme` 统一管理顶栏、工具栏、时间线、事件行、字号、图标和安全区。功能包只消费语义 token，不建立第二套颜色或逐行 elevation 系统。

## 曾考虑的替代方案

**用负 margin 把现有 Session header 覆盖到 AppFrame 上。** 不采用，因为位置依赖 shell 高度，会产生重叠焦点顺序，也无法为后续会话工具提供声明式归属。

**保留桌面表格并不断缩小文字。** 不采用，因为折行后的表格仍暴露桌面列模型，窄屏上主事件文本会与元数据争夺空间。

**维护独立的移动轨迹状态和数据加载。** 不采用，因为重复的分页、搜索、流式更新和选择逻辑会逐渐偏离桌面 ledger。

## 后果

新的手机专属会话工具注册到移动顶栏 slot，并提供自己的 compact presenter。轨迹变更只扩展一次共享 record projection，再增加移动展示字段，不修改 session log、后端 API 或持久化格式。移动 presenter 使用固定行高，因此虚拟化可以在 prepend 历史时保持滚动锚点而不依赖运行时文字测量。
