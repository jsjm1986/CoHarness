# Agent Note: 不完整的进程表保留进程组所有权

Status: implemented

[English](2026-10-29-incomplete-process-group-observation.md) | 中文

## 问题

Linux 进程组后备观察可能读到一个僵尸进程，而另一条进程记录不可读或格式错误。跳过未知记录会把仍有活跃后代的进程组报告为仅剩僵尸。确认范围为空后，会永久停止后续信号并允许资源释放，因此不完整观察可能遗弃该后代。

## 决策

[进程组观察器](../../../../packages/subprocess/subprocess-local/src/proc-stat.ts)遇到任何读取失败或格式错误的进程记录时返回未知，除非观察到了目标进程组的活跃成员。即使记录在读取时消失，也属于不完整扫描：枚举不能证明该进程退出前没有留下后代。只有完整的僵尸进程观察才允许返回该后备结果。内核进程组消失和原生 scope 所有权保留现有行为及限制。

后备 POSIX [终端清理](../../../../packages/subprocess/subprocess-local/src/terminal.ts)在不完整观察期间保留已捕获的后代身份。成功清理要求最终进程表完整；未声明完整性仍表示未经确认。最终完整性检查在所属 spawn 配置的 `graceMs` 内重试不完整观察，始终保留已捕获身份。期限到达后证据仍不完整，就拒绝完成清理。清理失败后，句柄可以重试，提供方继续保留宿主退出回调。观察恢复后，精确身份检查约束信号目标，确认清理后才释放所有权。Windows 直接查询各进程身份，不依靠 POSIX 进程表完整性来允许清理。

POSIX 逐个身份的实时及快照查询保留相同的不存在/未知区分。不完整进程表中缺失的记录会拒绝本次观察；可见记录仍能证明其自身身份，或证明该 PID 属于不同的代际。Linux 直接 stat 读取将 `ENOENT` 与 `ESRCH` 视为不存在，并传播其他失败。格式错误或 PID 不匹配的 stat 数据不能作为身份证据；枚举会将此类记录标为不完整。终端整体的完整性保护仍然必要，因为单个身份不能证明完整的后代范围。

[Windows 观察器](../../../../packages/subprocess/subprocess-local/src/windows-inspector.ts)区分进程不存在与进程状态不可读。`OpenProcess` 使用固定访问标志时，将 `ERROR_INVALID_PARAMETER` 视为不存在；权限拒绝及其他失败抛出 `Win32Error`。创建时间读取失败和进程句柄等待失败同样抛错。Toolhelp32 枚举仅将 `ERROR_NO_MORE_FILES` 视为完成。这些失败会保留已捕获身份和清理责任，包括根进程已退出的情况。这遵循文档中的 [OpenProcess](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-openprocess) 与[等待](https://learn.microsoft.com/en-us/windows/win32/api/synchapi/nf-synchapi-waitforsingleobject)失败结果。

原生进程表查询和终止命令分别使用所属 spawn 的正数 `graceMs`，向上取整到整数毫秒，作为每个辅助进程的执行期限。超时辅助进程收到 `SIGKILL`；辅助进程返回绝不代表工作进程已停稳。查询失败会拒绝本次观察；尽力投递 `taskkill` 后，仍须独立确认工作进程退出。进程查询和终止工厂要求显式传入期限，同步宿主退出信号同样如此。逐个辅助进程的期限不约束整个拆卸流程或不可中断内核操作。

真实 Loader 回归使用实际存活的 POSIX 子进程，并注入具有不确定性的进程表输入。源码和编译提供方的记录要求共享退出等待持续未完成，直到终止操作移除该后代。单元场景覆盖权限拒绝、描述符耗尽、记录消失、格式错误和明确的活跃成员证据。

[原生 PTY 记录](../../../../packages/subprocess/subprocess-local/tests/fixtures/terminal-clock-driver.mjs)捕获抵抗 TERM 的后代，终止根进程，再注入不完整进程表，并要求拒绝清理、保留提供方的宿主退出保护。恢复观察后，重试先停止真实后代再释放。Linux 与 macOS 单元场景另行要求已知身份在观察失败后仍被保留。

其中的 Win32 观察场景运行实际 Loader、提供方和 PTY，并使用由真实 POSIX 进程身份支撑的 Win32 API 输入。注入权限拒绝后，必须保留实际存活的子进程以及已卸载提供方的退出回调，直到观察恢复。该场景检查清理决策和原生绑定的失败处理，不代表物理 Windows 执行已获验证。

## 考虑过的替代方案

**忽略消失的记录。** 进程可能在枚举后留下后代，并在记录被读取之前退出。因此，记录缺失不能建立完整的仅剩僵尸观察。

**对不可读的身份返回 false。** 调用方无法区分已退出的进程与不可用的观察。身份 API 独立于终端的完整进程表保护来拒绝不确定性。

**使用默认超时信号。** 原生辅助进程可以忽略 `SIGTERM`，使同步调用一直阻塞。`SIGKILL` 终止该辅助进程，但其退出不能作为工作进程状态的证据。

## 后果

不完整的进程观察可能延迟清理，但不能允许释放资源或禁用后续终止。[PTY 所有权决策](../feature/2026-07-16-persistent-pty-sessions.zh.md)和[无人使用终端决策](../feature/2026-09-14-unattended-browser-terminal-reclamation.zh.md)继续有效，因为它们拥有终端生命周期和空闲策略。本修改不增强后备机制对逃离进程组后代的约束，也不会使进程表扫描具备原子性。
