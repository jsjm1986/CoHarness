# Agent Note: 侧栏脚注按 Settings 行竖排

Status: implemented

[English](2026-08-19-sidebar-footer-stacked-rows.md) | 中文

## Problem

`sidebar.footer.action` 的占用者（项目空间、Cordis 清单、文档）各自要一条全宽触发器，但 `.footerActions` 是横向 flex。compact 抽屉（`min(85%, 320px)`）和 280px 桌面侧栏里，这些 `width: 100%` 的孩子互相挤压：空间名被裁成一个字，旁边的「可编辑」徽章不收缩，Cordis 触发器只剩 `Cordis Plu`。56px rail 同样是这一行，三个 36px 圆会横向溢出。Host、会话、设置写入路径均未改。

## Decision

`.footerActions` 是全宽行组成的一列。每个占用者使用 Settings 脚注、Cordis 徽章已共用的几何：`wide` 时为 42px 行（`width: calc(100% + 4px)`，内边距 `0 10px 0 8px`），否则为 36px 圆。空间名（以及 Cordis 文案）是 `flex: 1 1 auto; min-width: 0` 并可省略；模式徽章、箭头和运行计数保持 `flex: none`。compact 树内外壳通过 `[data-viewport='compact']` 把通栏行升到 `--dsw-touch-target`；rail 圆不升。返回 null 的占用者不留空位。slot 契约、inject 工厂和文案未改。

相关：[compact 外壳密度](2026-08-19-compact-chrome-density.zh.md)。

## Alternatives considered

**身份通栏，Cordis 与文档并排半宽。** 被拒：list 插槽包装是 `display: contents`，占用者集合可变，CSS 无法稳定区分「工具」和「身份」，除非再加一层分组 slot。半宽 Cordis 行仍会裁掉 `Cordis Plugin` 加运行计数。

**compact 把「可编辑」折到项目名下面。** 被拒：320px 通栏已经放得下短名加徽章；两行控件会破坏脚注其余部分共用的 42px Settings 节奏。

## Consequences

compact 抽屉和 280px 侧栏上，用户可以分行读到项目名、成员模式、Cordis 入口和文档标签，它们叠在 Settings 上方。收起的 rail 把同一组图标竖排。脚注按占用者各增高一行 42px（Settings 之上最多三行）；会话列表仍是 `flex: 1`。`panel.trigger` 在两份词典里仍是英文 `Cordis Plugin`。

## Testing

各包 CSS 契约规格钉住竖排、42px 行、36px rail 圆，以及 compact 的 `--dsw-touch-target`。ScopeControl 与 DocumentsButton 组件测试在 `wide` 为 false 时断言 `rail` 类。
