# Agent Note: Symmetric chat-width handles and ratio-sized details panel

Status: implemented

[English](2026-10-02-symmetric-chat-handles-ratio-details.md) | 中文

## Problem

两处对话面行为与上游 rc1 分叉。对话内容宽度控件此前是内容列右缘上的一个居中短把手——本 fork 早期的设计，刻意避开了全高侧条。详情面板（终端、文件预览、工具面板）使用固定像素几何：默认 360px，范围 300–520px，中栏下限 640px，因此在 1440px 级视口下面板宽度永远不超过窗口约三分之一，diff 与终端等宽内容显得局促。

## Decision

两个表面现在都采用上游几何，同时保留本 fork 的持久化后端。

- **`ConversationRoot` 在滚动区两侧各持一个 `WidthHandle` 条带**（左、右）。两者写同一条居中内容轴：任一侧向外拖动都按指针位移的两倍加宽，因此这一对把手等价于一个对称控件。手势模型是松手才提交——`pointermove` 只改写 `--dsh-chat-user-width` 变量（rAF 节流），无位移的按下不会用被列宽钳制后的值覆盖已存偏好。pointer capture 拦截游离指针的移动；`pointercancel`/`lostpointercapture` 放弃手势且不提交。指示光条是跟随指针已发布 Y 坐标的 3px 渐变条；填充模式（`chatFullWidth`）下 12px 条带收进两侧 16px 安全边距内，使拖拽入口在填满态下仍然可用。经 `setDisplayWidth` 的账户级 `chatContentWidth`/`chatFullWidth` 持久化保持不变——只是提交点从移动时移到松手时，且拖拽上限改为「列宽 − 176px 边缘预算」而非裸设置区间。

- **`ui-layout` 的详情面板几何改为视口比例**。`CENTER_MIN` 降至 400px；面板未设偏好时按 `max(300px, 视口×45%)` 解析、按视口 70% 封顶，因此 1920px 窗口首开为 864px、上限 1344px。store 字段改为 `details: number | null`——null 表示「从未拖拽」，框架每帧按实时视口重新解析比例，未触碰的偏好随窗口尺寸变化跟随。拖过的像素偏好在关/开与视口变化间保留；拖拽手势从让步后的渲染宽度起算，而非从偏好值起算。store 同时镜像 `viewportWidth`（由 AppFrame 的 ResizeObserver 喂入），使 `setDetails` 的钳制上限与求解器一致；`narrowExpanded` 取代原布尔 `narrow` 表达手动侧栏覆盖。rightbar 槽位 prop 在关闭态也报告假设宽度（`normal.details`），因为常驻隐藏的面板按其打开宽度布局。

## Alternatives considered

**采用上游的内容宽度 `localStorage` 持久化。** 否决：本 fork 有意将聊天宽度放进账户 transport 的 `ui-conversation` settings 段，使偏好跨端口与共享运行时跟随账户（[Host 侧 Web 偏好](../bug-fix/2026-08-06-host-backed-web-preferences.zh.md)）；退回浏览器存储会按 origin 重新分区该偏好。

**详情面板保留固定像素区间。** 否决：520px 上限正是被修的缺陷——宽视口需要成比例的更大空间，固定上限表达不了。

**首开时把比例默认值写入 store。** 实现中途否决：把首开视口的 45% 落成像素会把瞬时窗口尺寸冻结为永久偏好；字段保持 null 到首次拖拽为止，默认值才能持续跟随实时视口——这正是上游语义。

## Consequences

对话区可从任一侧加宽，拖拽位移对称地双倍改变宽度，中止或无位移的手势不会污染已存偏好。详情面板在大窗口下明显更宽（1920px 下 864px，旧值为 360px），拖过的选择在无刷新的视口变化间保留。

从未拖过的用户会看到面板宽度跟随窗口而非冻结数值——这是有意的：像素偏好只在显式选择后才存在。聊天宽度偏好仍以 560px 设置下限为底，尽管把手会先按列缘预算做视觉钳制。

## Testing

`ui-layout` 的 columns/store/AppFrame spec 覆盖比例求解、让步链、null 偏好跟随、overlay 宽度与假设宽度报告（81 个测试）。`ui-conversation` 的 skeleton spec 覆盖双侧对称拖拽、capture 门控的移动、松手提交、cancel 恢复、176px 边缘预算上限、键盘步进、填充模式拖拽基准与 hero 相位缺省。
