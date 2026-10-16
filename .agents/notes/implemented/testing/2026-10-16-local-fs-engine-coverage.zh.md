# Agent Note: 本地文档引擎补全覆盖率中的共享扫描与生命周期分支

Status: implemented

[English](2026-10-16-local-fs-engine-coverage.md) | 中文

## Problem

`packages/attachment/userdoc-local/src/local-fs.ts` 在每文件 100% 覆盖率门下只有 84% 语句覆盖和 47% 分支覆盖。未覆盖区域不是零散死代码，而是 `SharedRead` 的取消契约（到达时已中止的 waiter、最后一个离开的 waiter 中止底层扫描、非 Error 原因包装、`cancel` 在 settle 前后）、维护清扫体（`attach` 的 interval 守卫、purge 失败吞错、任务簿记）、dispose 连接进行中的扫描与未决清扫、`ensureReady` 首次初始化失败后的重试，以及 `completeUpload`/`cancelUpload` 的失效面。这些缺口之所以没被发现，是因为引入该包的 PR 从未跑到一次完成的 coverage 任务。

## Decision

`tests/local-fs.spec.ts` 直接驱动引擎而不是经由 `LocalUserDocStore` 服务面，因此取消与生命周期状态可以放在确定性节点上：deferred promise 通过 `vi.spyOn` 源模块让 `listDocFiles`、`listDocDirectory`、`listTrash` 和 `purgeDueDocuments` 保持挂起（`upload.spec.ts` 对 `withFileLock` 用的是同一手法），`vi.useFakeTimers()` 同步推进清扫 interval 而清扫任务本身保持真实，`dispose()` 对 `trashSweepTask` 与 `activeReads` 的连接就是静默拆解点。spec 不伪造 `node:fs`——那条边界归 `store-failures.spec.ts` 管。

覆盖率测量正确拒绝的三处不可达分支从源码里移除而不是在 spec 里绕行：`SharedRead.wait` 的 promise executor 中 `signal.aborted` 复查不可能在同步入口检查与 listener 注册之间观察到状态翻转；`this.trashSweepTask === task` 恒真，因为该字段只在 `undefined` 守卫之后被赋值一次；`this.ready === ready` 恒真，因为该字段只有在 catch 清空之后才可能被重新赋值。三处都改为无条件语句。

## Alternatives considered

- **让 spec 绕过死分支** —— 三处守卫语句在单线程执行中没有可达的假分支，任何号称覆盖它们的测试都只能走真侧而让门禁继续红；诚实的修法是删除。
- **把取消内部豁免出门禁** —— `SharedRead` 恰恰是包里最可能无声回归的部分（双重释放或泄漏的扫描只在并发下暴露），正是每文件阈值要钉住的东西。
- **全部走服务面驱动** —— `LocalUserDocStore` 测试已经覆盖快乐路径，但服务无法在 listener 注册前安插 waiter 中止、也无法让扫描跨 mutation 保持挂起；直接访问引擎才让竞态确定性而非概率性。

## Consequences

引擎中每条取消与生命周期分支现在都有确定性的归属测试。门禁抓住了真实的死代码，删除让文件略微变小。代价：无用户可见变化——删掉的守卫本来就是惰性语句，行为没有变化。
