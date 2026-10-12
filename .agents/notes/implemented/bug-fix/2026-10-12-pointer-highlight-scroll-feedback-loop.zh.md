# Agent Note: 指针悬停不得驱动可见性滚动

Status: implemented

[English](2026-10-12-pointer-highlight-scroll-feedback-loop.md) | 中文

## Problem

每个追逐高亮的选择器——两个模型选择器和 `/` 触发菜单——都在每次高亮变化时把高亮行滚入视野，包括指针悬停触发的高亮。悬停行本就在指针之下，而把它滚动到完全可见会让静止指针下方的行发生位移；浏览器对新滑入指针下的行再次触发 hover，写入新的高亮，再触发下一次滚动。这个修正自我循环：滚动端口停在偏离顶部的位置或来回振荡，粘性分组标题在没有用户滚动的情况下持续携带 `data-stuck`。在负载饱和的 CI runner 上，该循环的存活时间超过了 `default-model.e2e.ts` 的重置轮询窗口——整个窗口内 `/model` 弹层一直被钉在列表中段。

## Decision

`PopupState` 在最后一次 `active` 写入上记录 `activeViaPointer`，`PopupSelectView` 只对非指针来源的高亮执行滚入视野修正。`highlight()`——指针入口——置位该标记；`move()`、`setSearch()`、选项加载和加载失败将其复位，因此键盘与程序化高亮仍然保有该 effect 存在的意义：维持键盘高亮可见。`ModelSelect` 的悬停路径通过一个 ref 标记同样的来源，并用 `preventScroll` 聚焦悬停行，使 effect 与原生聚焦滚动都无法移动指针下方的内容。触发菜单的 `menuReduce` 为 `hover` 事件写入的 `highlight` 加盖 `viaPointer`——`move` 与 settlement 产出的高亮不带该标记——`MenuView` 跳过对带标记行的滚动，与弹层相同的划分，只是标记携带在 highlight 对象内而非平级字段。

## Verification

`popup.client.spec.ts` 断言该标记在 `highlight` 时置位、在 `move`/`setSearch` 时清除；`popup-view.client.spec.tsx` 断言 mouseenter 移动 `aria-selected` 但不调用 `scrollIntoView`，而 ArrowDown 仍然滚动。`core-menu.client.spec.ts` 断言 `hover` 加盖标记、`move` 摘除标记；`menu-view.client.spec.tsx` 断言带标记的高亮不触发滚动。一次带插桩的浏览器运行记录了修复前的循环（hover → scrollIntoView → 新行进入指针下 → 重复，最终停在 scrollTop 6），修复后 hover 不再跟随滚动——`scrollTop` 保持在重置位置，`default-model.e2e.ts` 通过。

## Alternatives considered

**把 hover 事件按帧合并为一次高亮。** 否决：该循环每次 hover 只需一次滚动就能喂出下一次 hover，节流只会放慢循环而无法打断它。

**在测试里把指针移出列表。** 否决：该循环是产品缺陷——用户把光标停在选项列表上等待高亮稳定时会遇到同样的滚动追逐——所以应由滚动决策的属主修复，而不是测试。

**把来源记录留在各视图内部。** 否决：`active` 本就经由 `PopupState` 流转；在那里记录来源能约束所有写入方（加载、搜索、移动、悬停），而不是在每个消费方重复约定。

## Consequences

- 指针悬停只移动 `aria-selected`/`data-highlighted`，不再触碰滚动位置；键盘与程序化高亮保留可见性滚动。
- `PopupState` 新增 `activeViaPointer`，`MenuState['highlight']` 新增 `viaPointer`；未来新增 `active`/`highlight` 写入方必须声明指针或程序化来源。
- [分组模糊模型选择器 note](../feature/2026-10-02-grouped-fuzzy-model-picker.zh.md) 仍拥有分组与粘性标题机制的所有权。
