# Agent Note: Recover transcript receipts through older history pages

Status: implemented

[English](2026-11-25-transcript-receipt-history-recovery.md) | 中文

## Problem

transcript 提交回显只有在持久 `user/message` 确认浏览器持有的 `requestId` 后才会退役（[pending-submission 回显](../feature/2026-08-30-web-pending-submission-echo.zh.md)、[输入回显录取所有权](2026-10-13-input-echo-admission-ownership.zh.md)）。如果下行链路在录取时静默或断开，实时帧路径就会丢失该回执。重连修复只读取新的尾页，因此一个很大的轮次可能把录取回执和用户的持久消息都放在驻留窗口之前。此时即使 Host 已接受输入且助手回复可见，composer 仍会永远停留在 `submitting`。

有界活动窗口决策有意不为空闲会话继续自动扩展，并禁止尾页探测在完整窗口之后重新创建 `hasMore`（[有界活动窗口与增量重连](2026-09-03-bounded-live-window-and-incremental-reconnect.zh.md)）。该规则对非空完整窗口是正确的，但全新会话从一个空的完整窗口开始。之后的输入和工具输出一旦超过一页，恢复出的尾页就确实存在更早前缀，即使驻留窗口先前记录 `hasMore: false` 在当时也是准确的。

## Decision

空驻留窗口之后的尾页合并可以采用该页的 `hasMore`：空窗口没有提供任何重叠前序事件，因此之后的录取确实可能在尾页之前创建历史。非空完整窗口继续保留此前禁止复活前级页的规则。

首次打开、重新进入舞台或成功修复缺口之后，`Session` 会检查是否存在未录取的 transcript 回显。窗口基部显示存在更早历史时，它会沿连续的更早页面执行一次有界反向遍历，上限复用现有 `MAX_HISTORY_EXPANSION_PAGES`。遍历与其他历史变更串行，但不会一边到达一边发布每一页。如果某页携带匹配的 user-source `rpcId`，就把收集到的连续批次一次性 prepend；持久消息替代 transcript 中的本地回显，现有录取观察器仍恰好使其退役一次。如果遍历到达日志开头、遇到不连续或达到上限仍未找到回执，就丢弃这些页面；缺失不被视为拒绝，因为录取可能仍在进行。

恢复遍历安装的页面计入活动历史保留预算。queued 或 steering 回显不因此依赖 transcript 历史：这些位置已经以队列发布和 splice 结果作为录取表面。

## Alternatives considered

- **依赖 running 状态的活动历史扩展**——扩展只在处于舞台且 running 的会话中启动，而且可能在大轮次创建更早页面之前就已经结束。失败场景恰恰是在 Host 轮次已经空闲后才重连。
- **只使用 `session.promptStatus` 或受管持久录取**——受管回执路径仍是跨电脑场景更强的机制，但普通本地提交也必须能通过持久日志调和。回执遍历还复用 history API 已经暴露的 user-message 证据。
- **扫描但不安装页面**——这样虽然能清空 composer，却会让用户可见消息随本地回显一起消失。prepend 连续批次能保留 transcript，而不是只留下助手回复。
- **即使没有找到回执也安装所有扫描页面**——被拒绝或仍待处理的输入可能因此在没有任何用户收益的情况下把驻留窗口扩大几十页，重新引入有界历史已经消除的内存成本。

## Consequences

下行链路丢失不会再让已接受的第一条 prompt 卡在历史分页之后。持久用户消息会回到 transcript，而不是仅仅清掉本地回显；`hasMore` 也会重新反映初始空会话之后创建的最早前缀。恢复最多读取 64 个更早页面，并且只在存在未录取 transcript 回显时运行；普通发送仍通过实时或队列证据结算，不会启动遍历。

比该上限更靠后的回执，或历史链不连续时的回执，仍需要之后的读者操作或更新的恢复机制。遍历不能根据缺失证明未录取，因此会让回显保持待决，而不是在录取仍可能进行时误报失败。

## Verification

`packages/client/runtime/tests/session.client.spec.ts` 覆盖空窗口的 `hasMore` 转变，以及恢复尾页位于回执之后的重连：恢复遍历请求更早页面、prepend 该页、按 observed 退役回显，并保留尾页行。keyless Playwright `submission-history-receipt` 场景在静默下行链路直到轮次完成后，使用真实 Host 与生产分页通过。

## Related

- [Web pending-submission 回显按请求身份收敛](../feature/2026-08-30-web-pending-submission-echo.zh.md)
- [输入回显录取所有权](2026-10-13-input-echo-admission-ownership.zh.md)
- [有界活动窗口与增量重连](2026-09-03-bounded-live-window-and-incremental-reconnect.zh.md)
