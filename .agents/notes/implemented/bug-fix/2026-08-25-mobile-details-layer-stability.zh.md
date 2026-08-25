# Agent Note: 紧凑端详情层保留语义标题并覆盖 composer

Status: implemented

[English](2026-08-25-mobile-details-layer-stability.md) | 中文

## Problem

紧凑端轨迹行使用窄图标栏，但事件详情标题也复用了同一个 kind 标签。行级宽度规则作用到标题后，较长的 `ASSISTANT` 会绘制到详情层和视口之外。紧凑端详情层打开时，动画遮罩的首帧还可能让固定 composer 短暂可见。

## Decision

折叠 kind 标签和图标的选择器只作用于轨迹表行。详情标题使用可收缩的标题组、可省略的位置信息和按内容宽度保留的语义 kind 标签。详情打开标记用于会话和轨迹的 stacking 规则。紧凑端遮罩在首帧立即绘制；详情层保留垂直入场动画，并从不透明首帧开始。

## Alternatives considered

**让标题继承紧凑端轨迹行的标签宽度。** 不采用，因为标题是阅读区域而不是事件栏，窄视口仍会裁掉较长的语义标签。

**把每个轨迹详情层都 portal 到 `document.body`。** 不采用，因为现有的会话作用域选择、焦点恢复和滚动归属可以保持在本地；显式 stacking 状态即可修复归属问题，不需要复制 presenter 路径。

**移除所有紧凑端详情层动画。** 不采用，因为详情层可以保留垂直动画而不暴露 composer；仅移除遮罩透明度的首帧过渡。

## Consequences

紧凑宽度下，Assistant、System 和其他详情标题都保持在视口内，同时轨迹行继续使用低成本图标投影。详情层挂载后 composer 立即被覆盖，较慢的移动 WebView 也不会看到两套显示层。紧凑端遮罩不再淡入，但模糊和颜色处理不变；除非用户请求减少动画，详情层仍保留入场动画。

## Testing

紧凑样式、轨迹表/视图、conversation chrome 和 primitive 紧凑端测试合计 75 项通过。组装后的浏览器视觉审计使用真实 Chromium 覆盖 390×844、375×667 和 320×568，检查 assistant 标题边界，并在详情层动画前后采样 composer 命中层。客户端构建和 typecheck 通过。
