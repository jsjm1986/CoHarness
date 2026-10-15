# Agent Note：长会话输入探针移除逐键驱动往返

状态：已实现

[English](2026-10-16-long-session-input-probe.md) | 中文

## 问题

`benchmarks/long-session-browser/long-session.bench.ts` 的 `input` 预算（参考值 500 ms → CI 预算 1250 ms）开始间歇失败，中位数 1285–1956 ms。探针本身已采集的见证数据（`data-benchmark-input-timing`）显示，可信 input 事件在 ~1–2 ms 内即被处理；测得的延迟其实是 Playwright 驱动端通过逐条 CDP `Input.dispatchKeyEvent` 往返键入 23 个字符的开销——共享 runner 上主流线程正忙于渲染流式分块时每次 ~50–80 ms——再加上 `expect.poll` 与两次 `requestAnimationFrame` 等待。这是测量装置本身的线路成本，而非 composer 回显延迟，且随 runner 繁忙程度伸缩——这正是同一份代码以 1231 ms 中位数通过、又以 1332 ms 失败的原因。

## 决策

被测探针改用 `page.keyboard.insertText(...)`，以一次 CDP 调用发送携带完整探针字符串的同一条可信 `input` 事件。断言面不变：`expect.poll` 仍验证 React 回显落到 `textContent`，`data-benchmark-input-overlap` 仍要求可信事件在流式中途到达，`painted()` 仍等待两次渲染机会。预算现在测量的是流式期间的事件到回显延迟——即该预算本来要守护的用户可见量——只是去掉了逐键派发放大。500 ms 参考值保持不变，因为被测量未变。

## 已考虑的替代方案

- **上调 `REFERENCE.input`**——按膨胀后的测量值放宽常量可以消除抖动，但探针读数仍由驱动端线路成本与 runner 负载主导，同时会抹掉预算用来标记真实回显回归的余量。
- **用 MutationObserver 做页内事件到回显计时**——能以更少的驱动端参与测量同一个量，但需要新增观测管线，而 `insertText` 原样复用了现有见证、轮询与绘制断言。
- **增加样本数或失败重试**——更多样本与重试只是用更长的运行掩盖测量伪影，而不是移除它。

## 后果

- 预算恢复真实余量：流式期间页内回显为数十毫秒级，若未来出现饿死输入处理的回归，仍会在远低于 1250 ms 处失败。
- 探针不再覆盖流式期间逐字符 `keydown`/`keyup` 派发；未计时的后置输入探针仍保留 `keyboard.type`/`press` 对该路径的覆盖。
- 若未来某改动让单次插入显著变慢（例如昂贵的同步 `input` 监听器），该指标仍能通过 `expect.poll` 计时捕获。
