# Agent Note: Chat 滚动归属由 floor 几何判定 at-bottom

Status: implemented

[English](2026-09-16-floor-geometry-owns-at-bottom.md) | 中文

## Problem

`ChatView` 的滚动监听器通过 observed-top 账本判定归属：送达的 `scrollTop` 与 `min(observedTop, floor)` 相等时视为非读者写入，`isAtBottom` 随后原样继承 `atBottomRef`。浏览器驱动的 `scrollTop` 写入——重排期间的 scroll anchoring、收缩钳位、合成器投递——从不进入该账本。一旦某个落在 floor 之外的未记账写入把 ref 翻成 `false`，随后恰好钳到 floor 的浏览器写入会继承这个陈旧的 `false`：读者明明坐在末尾，跟随却保持解除，"回到底部"按钮一直挂载着，直到手动滚动才消失。该缺陷在 CI 上表现为 `question-composer` 的 aria golden 偶发失败——已回答转录快照间歇抓到残留的按钮。

## Decision

`isAtBottom` 现在由纯几何决定——`floor - scrollTop <= FOLLOW_THRESHOLD + 1`——与写入方无关。当 ref 为 `false` 时，`!movedByReader && isAtBottom` 早退路径会重新武装归属：按读者滚回底部同样的方式清除分页锚点与已保存的读者位置，然后重跑 `toBottom`。账本仍负责归类读者输入（相对 `min(observedTop, floor)` 的偏离），因此真正的读者滚离 floor 依旧解除跟随；只有 at-bottom 判定不再参考 ref。

## Alternatives considered

**在滚动口上加 `overflow-anchor: none` 压制浏览器写入。** 否决：它只解决 scroll anchoring，管不到收缩钳位或其他合成器投递，还会让停在中部历史的读者失去 anchoring 在新内容到达时保持视口的收益。

**保留 ref 继承的 `isAtBottom`，在 e2e golden 里归一化掉按钮。** 否决：这是掩盖产品缺陷——跟随永久失效、按钮卡死——而不是快照伪影。

**在 `captureStableAria` 里等待落定状态。** 否决作为修复：抓到的状态本身是错的（按钮已挂载且不会卸载），等待只会让错误状态变成确定的。

## Consequences

任何落在 floor 的位置都会重新钉住跟随，包括浏览器钳位与 anchoring 写入，"回到底部"按钮不再可能残留。读者滚动依旧解除跟随、保存位置以便恢复并挂载按钮；点击按钮或滚到底部经由同一路径重新钉住。`movedByReader` 归类不变，因此先于事件到达的合成器投递位置仍归读者。

## Verification

`chat-view.client.spec.tsx` 覆盖该回归：floor 之外的未记账写入解除跟随并挂载按钮，落在 floor 的收缩钳位重新钉住并清除已保存位置，随后的流式增长再次到达末尾。既有的流式收尾钳位、合成器投递与读者滚动用例继续钉住周边契约；`apps/web/tests/question-composer.e2e.ts` 是暴露该缺陷的金丝雀。
