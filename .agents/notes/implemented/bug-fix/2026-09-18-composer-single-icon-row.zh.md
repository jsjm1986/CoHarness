# Agent Note：移动端 composer 保持单行纯图标工具栏

状态：implemented

[English](2026-09-18-composer-single-icon-row.md) | 中文

## 问题

手机端 composer 按设计把控件渲染成两行：只要存在模型槽位，紧凑 CSS 就把尾组（模型槽 + 上下文计量 + 发送）挪进单独的网格行；≤359px 时再用一条会话摘要条整个替换模型槽。结果是每台手机上的 composer 都永久变高，与桌面卡片的单行框架相反。

## 决定

每个紧凑控件在任何宽度下都是单行上的纯图标触发器。模型槽只渲染 `IconBrainOutline16`，权限槽只渲染按权限级别区分的盾牌字形，上下文计量、附件和发送控件保持既有字形。输入控件契约中的 `summary` presentation 被移除；点击任一紧凑触发器仍打开既有的会话设置面板，完整标签都在那里。紧凑图标目标为 40px，360px 以下降到 36px，使七个控件仍能放进 320px 卡片；tools 网格列宁可裁切也不允许换行。可访问名称与 title 仍携带完整的模型/权限文本，非紧凑层级完全不变。

相关：[统一移动端会话设置](../architecture/2026-08-24-unified-mobile-session-settings.zh.md)（本笔记在工具栏一侧反转的 Sheet 架构）、[compact 框架密度](../architecture/2026-08-19-compact-chrome-density.zh.md)。

## 备选方案

**保留带文字的模型 chip 并更狠地截断。** 否决：可读的模型名加推理等级加权限标签无法在 320–390px 下与附件、命令、计量和发送共用一行；截到几个字符就不再有辨识度。

**把尾组移出卡片。** 否决：把发送键与 composer 拆开会破坏卡片的视觉归属，也会与 hero 已有的框架重复。

## 影响

紧凑 composer 再也不会把模型/发送组折到第二行，包括 `data-viewport='compact'` 生效的窄工作台分栏。输入控件的 `presentation` 联合类型现在是 `'trigger' | 'section'`；处理过 `'summary'` 的槽位实现必须删掉该分支。44px 触控目标 token 不再决定紧凑 composer 控件尺寸，后者归入 40px/36px 图标目标族。

## 测试

`composer-model-mobile.e2e.ts` 在真实浏览器中于 390/375/320px 测量组装后的卡片，要求模型槽位于 tools 与 send 之间、单行、且在卡片内；提交的 golden 记录新契约。单元 spec 断言紧凑触发器保留可访问名称，compact-chrome 样式 spec 断言强制换行的选择器已不存在。缺口：纯图标 affordance 依赖会话面板提供辨识，首次使用时模型/权限槽的可发现性弱于带文字的 chip。
