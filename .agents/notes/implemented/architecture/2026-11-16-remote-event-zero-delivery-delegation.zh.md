# Agent Note: Remote event zero-delivery delegation

状态：已实现

[English](2026-11-16-remote-event-zero-delivery-delegation.md) | 中文

## 问题

上游 rc.3 将 `approval/request` 与 `user-questions/request` 作为 waterfall Remote 事件转发：`startRemoteEvent` 登记 pending 调用并投递给所有可应答 Client(`answers` 主体）。结果、拒绝、全部委派（result 后 `deliveries.size === 0`)、取消、来源拆除均有结算路径，唯独"起始即零投递"没有：调用无限期等待晚连接的 Client 代，waterfall 监听者永远走不到 `next()`，其后每个本地监听者——包括本 fork 经 mux 广播 `question/requested`/`approval/requested` 的 provider——全部饿死。与上游不同（其 web 客户端本身就是 Remote-event Client),fork 的浏览器走旧 mux 下行通道，因此无 Remote peer 的 Host 上每个浏览器问答与审批都会死锁：侧栏显示等待，composer 永不渲染，turn 永不完成。

## 决策

- `startRemoteEvent` 在初始投递循环产生零投递时即结算 `{ kind: 'next' }`：无可应答 Client 能看到的 waterfall 立刻委派给下一个本地监听者。提问时已连接的 Remote peer 保持优先；保有至少一个投递的 pending 仍会送达晚连接的代。
- `removeRemoteEventClient` 在中途应用同一规则：断连清空最后投递时，pending 即刻委派，不再等待可能永不到来的重连。

## 影响

- 无 Remote peer 的 Host 与 rc.3 之前一样经本地 mux 通道应答问答与审批；挂了 owner peer 的 Host 保持远端优先。
- 零 peer 窗口期产生的 pending 不再能被晚连接的代认领——用排序换了死锁消除。
- 断连即回落本地是多代竞态下的行为变更，已由更新后的 host spec 覆盖。

## 备选方案

- 将 mux 订阅注册为 Remote-event Client——否决：为复刻上游已表达为 'next' 的排序，要在两套线协议上重复实现应答 UI 契约。
- 反转 waterfall 注册顺序让本地 provider 先行——否决：Remote peer 即使已连接也永远看不到交互，等于废除转发功能。

## 验证

- `gateway-remote-events.host.spec.ts`：零投递用例断言立即 `{ kind: 'next' }` 委派；晚连接代用例对保有投递的 pending 保持转发覆盖。15/15 通过。
- 真实浏览器 e2e(`apps/web/tests/`):question-composer、approval-composer、timed-question-claim、live-interactions、steering、chat-long-interactions、documents-interaction-audit、permission-policy-context 在重建后的 `lib/` 产物上全部通过——ask 到达本地 provider,composer 渲染，答案完成 turn。
