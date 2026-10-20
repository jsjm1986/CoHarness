# Agent Note: 十枚 ic_ds_* 图标改用内联 Phosphor 路径

Status: implemented

[English](2026-10-15-phosphor-glyph-subset.md) | 中文

## 问题

图标目录此前全部由 Lucide 支撑，但与参考设计系统使用的 Phosphor 图标逐行对比后，有十枚图标 Phosphor 的隐喻更准确或在 16px 下更清晰：侧栏收起（`sidebar`）、技能（`squares-four` 对比连锁积木 `blocks`）、分享动作（`export` 对比网络节点 `share`）、工作区树（`tree-structure` 对比 `folder-tree`）、加载弧（`spinner-gap`）、面板放大/最小化组（`arrows-out` / `arrows-in` / `corners-out`）、成员组（`users-three`）与日历（`calendar` duotone）。

## 决定

`packages/client/ui-primitives/src/icons/index.tsx` 新增 `ph()` 工厂：在 256 网格上以内联 Phosphor 路径渲染 `fill="currentColor"`，`IconProps` 契约（`size`、`className`、svg 透传）与 `glyph()` 导出完全一致。duotone 选型传入 `[副层, 主形]` 路径元组：副层先按 45% 透明度绘制——即参考实现的双层色处理。不引入新依赖：十条路径字符串集中在 `PH` 常量里，图标模块保持自足、可审计。

同一次改动移除了不再被引用的 Lucide 导入；所有导出名与绘制尺寸不变，消费方与 golden 无障碍快照（裸 svg 的 `img` 角色）不受影响。

## 备选方案

**依赖 `@phosphor-icons/react`。** 否决：为十枚图标引入第二个图标库会让静态 bundle 的图标机制翻倍，且上游 duotone 副层固定 20% 透明度，而采用的方案是 45%。

**整套迁移到 Phosphor。** 否决：Lucide 是描边系、Phosphor 是剪影系，整体混用会造成风格冲突。替换只限形状明显更优的行。

**保留 Lucide 仅加副层。** 对这些行否决：描边轮廓上叠 45% 副层得到的剪影比原生 duotone 更糊。

## 影响

后续图标替换沿用同一模式：提取路径、加 `PH` 条目、重绑导出——无需改动消费方。`tests/icons.client.spec.tsx` 的目录计数测试仍守住导出面，currentColor/无调色板断言覆盖内联路径。
