# Agent Note: 全局 Worker 补丁必须按构造点归属记录

Status: implemented

[English](2026-11-09-global-worker-patch-attribution.md) | 中文

## Problem

`packages/experimental/inspector/tests/fixtures/managed-debugging.mjs` 通过补丁 `require('node:worker_threads').Worker` 记录进程内全部 Worker 构造，再对每个组合的 `before` 窗口内捕获的记录等待 `exit`。Windows CI 上第一个组合确定性挂死 480s,Inspector teardown 全程静默；master 时代与 POSIX 车道却秒过。teardown 标记显示 9 个 disposer、worker 优雅 `shutdown`、`fiber.dispose()` 全部完成——等待停在 fixture 自己的 `Promise.all(workers...completion)`。

## Decision

Worker 记录现在携带构造栈与构造点分类：栈中出现 `inspector/` 路径段即属 inspector worker。completion 等待、`closedByPolicy` 与组合计数断言只读过滤集合，watchdog dump 仍报告全部捕获记录。

## Alternatives considered

- **按脚本 URL 过滤**(`data:` bootstrap vs 文件路径）——inspector 的 src 与 lib worker 目标形态不同，外来的 `data:` URL worker 又会误判；路径段谓词跨启动模式只此一条。
- **在组合起点而非每组合打 `workers.length` 快照**——后续杂散构造仍落入每个窗口，且掩盖其引入位置。
- **对全部记录等 `exit` 但设上限**——裸超时式掩盖：断言实际捕到的池 worker 设计上就不退出，任何上限都无法区分「慢」与「永不」。
- **删掉 Worker 补丁只断言 `outcome`/`status`**——丢掉唯一能证明 inspector 自有 worker 已退出而非泄漏的信号。

## Consequences

实际捕到的外来记录是 tsx 的 esbuild `startWorkerThreadService` worker——首个 `transformSync` 时懒启动。快机上首个 transform 在 `import(boot/app-boot)` 预热期发生（窗口外）；慢机上落进首个 `loader.create` 内被 `before` 切片捕获。这条时序轴——而非分支代码差异或 Inspector teardown——正是 Windows/POSIX 分歧与分支内不确定性的来源。未来任何进程级池 worker(resolver 服务、打包守护、测试运行时助手）同样处理：从断言集合中归属出去，仍留在 watchdog dump 里。

凡 spec 打进程级构造器补丁（`Worker`、`ChildProcess`、`net.Socket`）再对场景中途切片断言者，适用同一模式：补丁必须按构造点分类记录，否则慢机会让外来的懒构造落进窗口。
