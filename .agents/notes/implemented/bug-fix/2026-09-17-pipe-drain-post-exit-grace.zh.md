# Agent Note: 子进程退出后管道排空设上限

Status: implemented

[English](2026-09-17-pipe-drain-post-exit-grace.md) | 中文

## Problem

`sandbox-windows-acl` 的 `drainPipe` 轮询 `PeekNamedPipe` 直到写端报告干净 EOF（`ERROR_BROKEN_PIPE`/`ERROR_NO_DATA`）。继承了管道写句柄且比被孵出子进程活得久的后代进程会一直保持管道打开，于是 spawn 的 `wait()`——先等两个 drain 再 `waitForExit`——永不返回。kill-on-close job 帮不上：它只在句柄关闭时终止成员，而那发生在 wait 之后。

## Decision

`drainPipe` 接收子进程句柄，每轮迭代用零超时 `WaitForSingleObject` 探测其退出——这是一次不消费句柄的存活读取，句柄仍归 `waitForExit` 所有。子进程一旦退出，EOF 等待由 `PIPE_DRAIN_POST_EXIT_GRACE_MS`（2 秒）封顶；宽限到期则 drain 关闭读端并返回已收集的前缀。EOF 先到仍立即生效——该上限只兜住它缺席的情形。

## Alternatives considered

**子进程退出即截断。** 否决：行为良好的子进程恰在退出前冲刷最后字节；在退出边缘切断排空会丢失管道仍持有的缓冲输出。

**EOF 停滞时 kill job。** 否决：job 的 kill-on-close 是孤儿兜底而非输出期限；为逼出 EOF 而杀后代进程改变了 spawn 实际运行的内容。

**把挂起记为已知限制。** 否决：沙箱内子进程孵出驻留孙进程是寻常行为，无界的 `wait()` 会把它变成调用方可见的挂起。

## Consequences

`wait()` 必定落定：输出在干净 EOF、进程收尾或退出后宽限三者先到者处结束。驻留后代至多截断其自身退出后存活时长加两秒的捕获尾部。

## Verification

`failure-paths.spec.ts` 用打桩的绑定表驱动 `drainPipe`：管道从不报告 EOF 而进程轮询为已退出；drain 以已收集前缀解决且仍关闭读句柄。
