# Agent Note: Systemd 控制客户端具有有界的受管生命周期

Status: implemented

[English](2026-10-25-systemd-control-command-ownership.md) | 中文

## 问题

卡住的 systemctl 客户端可能无限期占住 Runtime 启动、存活检查或终止流程。客户端没有收到取消信号时，调用方取消无法关闭它；普通环境继承还会向宿主辅助程序暴露部署凭据。客户端终止也不能证明 systemd 是否已接纳底层服务作业。

## 决策

Gateway 原生 systemctl 客户端使用经过校验的 `HGW_SYSTEMD_COMMAND_TIMEOUT_MS` 期限，默认 120000 毫秒。启动把取消信号传入 daemon reload 和 restart；授权准备结束后观察到取消时，不发布单元文件。原生命令执行过滤 Gateway 与凭据环境变量，使用 C locale 保持机器解析的诊断稳定，禁用 systemctl 密码提示和分页器，并在成功或失败时都等待子进程原生 close 事件。取消会强制终止忽略 SIGTERM 的客户端；取消订阅保留到 close。显式取消所有者只向已分配的子进程 PID 发送信号；根据[创建失败时的取消规则](2026-10-29-native-command-cancellation.zh.md)，不使用 Node 内置的 AbortSignal 进程启动路径。隧道发现与解压共用该命令所有者。

Systemd Runtime 启动在发布凭据及进程准入前核验配置的 Unix 账号。账号准备仍由部署人员完成；账号缺失会直接报告，避免进入可预防的服务启动及清理流程。原生查询复用有界命令所有者，不改变服务代次的终止证据。

项目配置准备和特权文档发布通过同一原生命令所有者查询 UID/GID，每次查询采用 `HGW_READINESS_TIMEOUT_MS` 期限。取消或查询失败返回前，两项查询均已关闭；系统身份服务等待期间，Gateway 事件循环仍可处理其他工作。这些管理查询不会递归申请工作负载许可；调用方分别保留现有的启动或文档初始化所有权。

Linux 子进程提供者的同步探测、状态查询、信号发送及空单元回收采用独立的五秒期限。超时使用 SIGKILL 关闭原生客户端，包括忽略 SIGTERM 的程序；异步查询等待原生关闭，阻塞式调用返回后客户端也已结束。查询失败仍保持受管进程范围未知，不能据此报告任务停止或释放预留。该期限不限制目标任务的执行时长。

服务代次继续独立持有。restart 失败返回包含精确代次句柄的 `RuntimeLaunchCleanupError`，因为杀死 CLI 无法取消 systemd 已接纳或结果不确定的作业。停止先屏蔽该代次，再执行有界的 reload 与 stop 命令。停止或存活检查失败时保留不确定状态；只有未活跃或单元缺失证据使用退出码 3 或 4。[运行时准入](../architecture/2026-10-23-gateway-runtime-admission.zh.md)在确认服务终止之前保留预留，[本地监督](../architecture/2026-10-25-local-runtime-supervisor.zh.md)则单独持有 POSIX Runtime 进程组。

代次单元使用 `Type=exec`，在加载凭据并准备可执行文件后才确认 restart。其所有者私有的凭据源文件以 Runtime、代次和凭据指纹命名，在自动重启和 Gateway 替换期间保留，仅在已屏蔽的代次确认停止后移除。停止失败或结果不确定时保留源文件；旧句柄不能移除新代次的凭据。

## 考虑过的替代方案

**让命令 Promise 与计时器竞争。** 不采用，因为返回时子进程仍存活会丢失控制命令的所有权。

**CLI 退出即释放 Runtime 准入。** 不采用，因为服务管理器独立持有 Runtime；CLI 关闭只证明它自身已终止。

## 影响

管理控制命令具有有限等待，不消耗模型用户的执行额度。服务管理器不可用时，仍可能无法确认清理并保留 Runtime 预留。操作者可以为缓慢的服务操作增加期限。原生夹具客户端验证取消、超时、监听器关闭及环境过滤，不连接宿主系统管理器；这些检查不证明 Linux 服务或 cgroup 隔离行为。
