# Agent Note: 空间切换器改为卡片内嵌抽屉并采用身份磁贴

Status: implemented

[English](2026-10-13-scope-switcher-in-card-drawer.md) | 中文

## Problem

项目/空间切换器此前以从侧栏底部弹出的浮层卡片呈现列表。这层脱离卡片的表面读起来像一个独立控件而非侧栏卡的一部分，且每行只有一个通用圆点——空间变多后列表无法提供身份扫读，也无法快速区分个人、代管与普通项目空间。

## Decision

宽侧栏路径继续由 `Menu` 持有行为——选中、键盘导航、搜索、管理入口与关闭处理均不变——但以 `portal={false}` 渲染，使列表落在卡片脚注的正常文档流内。`.scopeSheet`（写成 `.scopeSheet.scopeSheet` 双类选择器，使覆盖在与 `Menu` 的 `.root`/`.list` 拼包序无关时仍生效）应用 `position: static` 与 `order: -1`，将面板直接置于触发器上方成为抽屉；`.regionArea` 按既有 `overflow: hidden` 收缩裁剪。面板以透明方式渲染在脚注列上（自身不带填充、阴影或圆角），`--dsh-menu-max-height` 取 `min(560px, calc(100vh - 150px))`，保证矮窗口下其下方的触发器仍可触达；面板头部区域承载[空间中枢 note](2026-10-13-scope-hub-sidebar-takeover.zh.md) 描述的常驻空间中枢。折叠轨道路径不变，仍渲染 portalled 浮层菜单。

各行以 20px 身份磁贴取代圆点：普通项目显示名称的首个 Unicode 码点（`Array.from` 保证代理对完整），底色按名称码点求和在蓝/绿/琥珀/红/深五种纯色中确定性选取；个人空间用圆形蓝色用户磁贴；代管项目用琥珀色盾牌磁贴。模式徽标（只读/可编辑、代管）仍是固定宽度的行尾文本。触发器本身佩戴当前空间的磁贴，且 `aria-expanded` 为真时 chevron 旋转 180 度。

相关：[sidebar footer stacked rows](../architecture/2026-08-19-sidebar-footer-stacked-rows.zh.md)——抽屉在同一叠放脚注之上扩展，行几何不变。面板的皮肤与置顶内容由[空间中枢接管 note](2026-10-13-scope-hub-sidebar-takeover.zh.md) 取代。

## Alternatives considered

**保留浮层菜单、仅重刷表面。** 否决：脱离的覆盖层仍悬浮在它所属的卡片之上，正是要消除的视觉断裂。

**命令面板式切换器（自动聚焦搜索 + 快捷键提示条）。** 否决：放弃 `menu`/`menuitem` 角色，并把管理入口挤进过滤行；其收益只在列表搜索已覆盖的规模之外才显现。

**不用 `Menu`、手写行列表。** 否决：仅为换皮肤而分叉选中、键盘与关闭语义。

## Consequences

- 抽屉是卡片内几何：打开时重排脚注并裁剪会话区而非覆盖其上，侧栏宽度变化时无需重定位任何 portalled 内容。
- `.scopeField`/`.scopeSheet` 使用双类选择器；编辑任一规则时保持双写。
- 轨道触发器保留圆形紧凑几何与浮层菜单；宽版与轨道不再共享列表表面。

## Testing

`components.client.spec.tsx` 断言字母磁贴（支付重构对应「支」）、代管盾牌磁贴，以及选中仍走 `onSelect`。`scope-control-styles.client.spec.ts` 词法锁定文档流契约——`order: -1`、`position: static`、透明表面、高度上限——以及磁贴度量与色调类。聚焦套件通过，`tsc -b packages/client/ui-collaboration/tsconfig.json` 干净。用真实 `Menu`/`MenuSurface`/主题样式表搭的 Chromium mock 实测面板在流内位于触发器上方。
