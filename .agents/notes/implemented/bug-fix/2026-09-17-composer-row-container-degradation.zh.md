# Agent Note：Composer 工具行按容器宽度降级

状态：已实现

[English](2026-09-17-composer-row-container-degradation.md) | 中文

## 问题

Composer 工具行承载八个控件（附件、文档库、命令、权限 chip、预设槽位、模型触发器、上下文表、发送），但窄宽度下只有视口驱动的应对：768px 以下 compact 印记把 trailing 组折到第二行，360px 以下 chip 整体卸载进设置 sheet 汇总条。宽窗口里的窄 composer——工作台会话列、被挤压的面板——两条规则都够不着，所有控件挤在一行里抢宽度，trailing 组只能生硬地整块折行。

## 决策

Composer 的 `.row` 是匿名 inline-size 容器（此前已为模型触发器的 `cqw` 上限声明），chip 按它在响应式 shell 词汇表的共享窄面板档 480px 降级：`PermissionSelect` 保留随级别变化的图标加箭头，`ModelSelect` 把名称和推理等级换成新增的 `IconSparkle16` 图标加箭头，完整身份信息仍由 `aria-label` 和 `title` 承载。300px 以下 trailing 组独占整行——即既有 ≤359px compact 规则的容器版。全部降级是纯 CSS；没有容器祖先的挂载点（会话设置 sheet）永不命中，标签保持完整。

## 已考虑的替代方案

**阈值以下固定两行。** 否决：列一窄就多花一行高度，而图标态 chip 在单行内其实还放得下。

**更宽处就收成汇总 pill 进设置 sheet。** 否决：把当前模型和权限藏到第二次点击后面；sheet 入口仍只属于手机端。

**在 480/560/720 之外新设容器档位。** 否决：共享词汇表的意义就在于面板在同一批宽度降级；而且长模型名带推理等级后缀本来就在 480 附近需要收起。

## 影响

任何窄 composer——手机、窄窗口、任意视口宽度下的工作台列——都会一致降级，因为查询回答的是卡片自身的宽度。图标态下每个 chip 的可见标签区收缩到 44px，但可访问名称和 tooltip 都保留。≤359px 卸载为汇总条的手机路径不受影响，模型菜单的底部 sheet 呈现也不受影响。

## 验证

`compact-chrome-styles` 与 `model-select-styles` 针对样式表文本断言容器档位；`model-select` 用例钉住 glyph 的 `aria-hidden` 席位以及 `title`/`aria-label` 上的完整名称。已在构建产物上实测 296–780px 的 composer 宽度：480 以上是完整标签，480 及以下收成图标 chip，300 以下 trailing 独立成行。

## 相关

- [响应式 shell 视口模式](../architecture/2026-08-14-responsive-shell-viewport-modes.zh.md)——本次遵循的匿名容器与共享档位词汇表。
- [Compact chrome 密度](../architecture/2026-08-19-compact-chrome-density.zh.md)——本次补充的 compact 视口规则。
