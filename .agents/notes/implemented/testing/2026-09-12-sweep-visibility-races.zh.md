# Agent Note：sweep 可见性竞态——replay 节奏窗口、hover-click 重试与失败证据上传

Status: implemented

[English](2026-09-12-sweep-visibility-races.md) | 中文

## 问题

在序列化的 master sweep 上，两个浏览器场景持续失败而 PR lane 上的同卵用例保持绿色。`steering.e2e.ts` 的 queue-flush 场景丢失了全部交互窗口：dock 展开按钮能 resolve 却 30 秒不可见，因为 question 卡片已当选 `conversation.composer` 的 overlay，而 fallback（含 dock）被 `display:none` 保留挂载。该场景的前缀（三次 fill、三次 Enter、展开）必须落在 call 0 的 replay 流内，该流当时按每 chunk 50ms 起节奏。`workspace-management.e2e.ts` 的 `clickHoverAction` 先 hover、轮询按钮可见、再点击——轮询与点击之间的 projection 刷新替换了行节点、丢落 `:hover`，hover-only 按钮再不出现。在交互之前创建的 `whenTurnSettled` 期限，在上游步骤先失败时还会以未处理拒绝的形式报出超时。本分支第一次全量 web verification 又暴露出第三个时序敏感读法：`document-manager.e2e.ts` 用四次串行 `boundingBox()` 依次测量 dialog、search、upload、more，dialog 未完成沉降时的重排让同一行的 upload/more 报出 80px 的行距，尽管 nowrap 的 action group 必保两者同行。

## 决策

steer-all 场景使用自己的 replay 节奏（300ms），让六次浏览器往返在饥饿 runner 上仍能落进服务端窗口；展开按钮按可访问名匹配，失败时在截图之外追加一份 DOM/布局 dump。`clickHoverAction` 把 scroll-into-view + hover + 有界点击折进同一个 30 秒期限的重试循环，每轮对新挂载的行重新 hover，耗尽时记录行的 DOM 状态。`settled` 期限挂一个标记性 `catch`，其拒绝只经真实的 `await` 抛出。document-manager 的几何断言改为在一次同步 `page.evaluate` 中读全部四个盒模型，调用之间的重排不再能把一行拆成两个读数。sweep job 在失败时上传 `.artifacts/`，`ci-workflow.spec.ts` 钉住 consumer 步骤不得导出 `DSH_SNAPSHOT`。

## 已考虑的替代方案

**按卡片已挂载分支处理。** 否决：overlay 当选后 dock 与 textarea 都被隐藏，展开与 Cmd+Enter flush 都无法执行——该场景要演练的顺序在测试中途不可恢复，且 fixture 的第二次调用已假定两个 steer 先落地。

**删掉 pre-flush 的 dock 行断言。** 否决：它们是多行 dock 折叠→展开渲染的唯一覆盖。放宽服务端窗口保住了这份覆盖而不是删除它。

**把 sweep 拆成独立的 web job。** 暂缓：`check:ci:consumers` 在 `DSH_GATE_CONCURRENCY=1` 下本就串行跑门禁，第二个 job 还需要独立 build 与第二份 client build record。争用假设没有经受住证据——失败是单操作停滞，不是吞吐损失。

## 影响

sweep 以适配高负载 runner 的窗口保持同等覆盖，hover-only 动作容忍 projection 抖动，每次红色 sweep 都把失败证据作为 workflow artifact 上传。`whenTurnSettled` 的期限不再在真实失败之上叠加未处理拒绝。
