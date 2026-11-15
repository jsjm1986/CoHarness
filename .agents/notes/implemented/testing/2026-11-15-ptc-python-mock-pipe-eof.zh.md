# Agent Note:受控子进程夹具必须像真实退出那样让管道 EOF

Status: implemented

[English](2026-11-15-ptc-python-mock-pipe-eof.md) | 中文

## 问题

`boot-write-failure.spec.ts` 用 `EventEmitter` 假子进程 mock `LocalSubprocessRuntime.spawnProcess`,其 `stdin`/`stdout`/`stderr`/fd-3 均为 `PassThrough` 流。运行时的 run 结算(`finish()`)会先 terminate 子进程、等待退出,然后在 `graceMs + CLOSE_REAP_MARGIN_MS`(5s)上限内把 `stdout`/`stderr` 排到流尾再 resolve。夹具从不结束这些流——没有仿真真实的 close 事件——于是每个结算的 run 都等满 5s 排空上限,每个用例恰好压在 Vitest 5s `testTimeout` 线上。一旦调度负载出现,上限定时器就晚于测试期限触发:20 个用例中 12 个以 `Test timed out in 5000ms` 失败。

## 决策

mock 在真实内核会送达 EOF 的每一处结束全部四条管道:子进程的 `close` 与 `error` 事件,以及无 pid 假进程的 `terminate()` 内(进程被终止即关闭描述符)。`endPipes` 对 destroyed/已结束流做守卫,并吞掉夹具注入的 `stdin.end` 抛错——写端本身就是注入故障的夹具不得把清理变成第二个故障。套件从约 64s、12 个负载相关超时,变为约 3.4s 确定性通过。

## 影响

伪造进程管道的夹具拥有管道生命周期:`close`/`error`/`terminate` 必须产生流 `end`,否则被测运行时会合法地等待其关闭上限,而测试将在一个合规实现上超时。凡是受控子进程管道的 `PassThrough` mock 都适用同一形态;新增此类夹具应在仿真退出点结束流,而不是依赖测试收尾时的销毁。
