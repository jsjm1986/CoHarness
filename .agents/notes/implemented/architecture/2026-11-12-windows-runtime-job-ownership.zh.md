# Agent Note：Windows 本地运行时 Job 所有权与 PID 复用围栏

状态：已实现

[English](2026-11-12-windows-runtime-job-ownership.md) | 中文

## 问题

Windows 没有 POSIX 进程组，受监督的运行时进程树一直依赖 `taskkill /PID <groupPid> /T /F`，仅以内核启动 UUID 作为围栏。同一启动期内被复用的 PID 仍指向一个存活进程，过期的清理可能向无关进程树发信号；监督进程以任何方式死亡都会遗留其运行时孤儿树。

## 决策

[local-runtime-win32-job.ts](../../../../gateway/src/local-runtime-win32-job.ts) 沿用 [node-windows-security-id.ts](../../../../gateway/src/node-windows-security-id.ts) 的加载模式，在 Gateway 内通过 Koffi 绑定 kernel32。`spawn` 成功后，[监督进程](../../../../gateway/src/local-runtime-supervisor.ts) 打开子进程并将其挂入新建的 Job Object，唯一限制为 `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`；监督进程终身持有该 Job 句柄，因此监督进程死亡时内核会收尾整棵进程树，`TerminateJobObject` 也取代 `taskkill /T` 成为强杀路径。挂接失败会使启动失败，并通过挂接前的 `taskkill` 回退路径终止子进程。

监督进程在 `starting` 发布时，把自身 `GetProcessTimes` 进程创建时刻（Unix 毫秒）作为 `groupStartedAt` 与 `groupPid` 一并记录。owner schema 要求该凭证随 `groupPid` 成对出现，`publish` 将已确立的 `groupStartedAt` 与 `groupPid` 一样视为不可变 capability。[local-runtime-control.ts](../../../../gateway/src/local-runtime-control.ts) 中所有 Windows 杀路径——卡死监督进程的 `taskkill` 与孤儿清扫——都先重开记录的 PID，并要求其创建时刻在四毫秒容差内匹配；已死或被复用的 PID 永不被发信号。该字段引入前写入的旧记录仍只受启动 UUID 围栏保护。

`scripts/ci-pr-proofs.ts` 现在把 `gateway/src/local-runtime-{supervisor,control,owner,win32}*.ts` 与 `node-{windows,private}*.ts` 映射到 `proof_native_windows`，使 Windows 归属的运行时控制改动运行在真实 `windows-2025` 完整门禁上，而非仅经 Wine 通道。

## 备选方案

**`packages/subprocess/win32-process` 的共享 `spawnJobProcess`。** 它通过调用方提供的 OS 句柄创建挂起态子进程，但监督进程的 `stdio[3]` 凭证管道由 Node `spawn` 持有；用原生方式复刻它会复制凭证交付契约，却不会带来额外所有权。

**仅做创建时刻围栏、不杀进程。** 它能挡住误杀复用 PID，但监督进程死亡后仍遗留孤儿树；Job 把收尾职责交给内核，而非依赖清扫。

**PowerShell `CreationDate` 凭证。** 每次检查都要付一个子进程开销，且返回本地化格式时间；`GetProcessTimes` 直接读内核时间戳。

## 影响

监督进程在 Windows 上死亡时由内核收尾运行时树，孤儿清扫降级为旧记录的回退路径。Job 挂接发生在 `spawn` 之后，间隙中退出的子进程仍由 `taskkill` 回退终止。`groupStartedAt` 以可选字段扩展 owner 记录 schema，无需迁移；严格解析不会放过未声明字段。Gateway 的 Windows 运行时控制文件现在会触发原生 Windows 验证，扩大了该通道的触发集。

## 验证

[local-runtime-win32-job.spec.ts](../../../../gateway/tests/local-runtime-win32-job.spec.ts) 在非 Windows 上验证「不可用」契约，并在原生 Windows 通道上验证创建时刻读取、复用 PID 拒绝与经 Job 的整树终止。owner 规格在 POSIX 主机上覆盖凭证持久化、与 `groupPid` 的成对要求及 capability 不可变性。
