# Agent Note: 可恢复的本地运行时监督

Status: implemented

[English](2026-10-25-local-runtime-supervisor.md) | 中文

## 问题

Gateway 被 SIGKILL 杀死时无法运行 JavaScript 退出清理。其独立本地 Runtime 仍可能提供 HTTP 服务，替代 Gateway 却没有进程句柄。释放准入会允许执行重叠，只保留占用而没有可恢复所有权又会阻止运维恢复。[启动韧性](../bug-fix/2026-08-18-gateway-startup-resilience.zh.md)中的 PostgreSQL 重试和不可变发布决策继续适用。

## 决策

[本地启动器](../../../../gateway/src/launcher.ts)在分配独立 Node 监督进程前提交私有预留。继承的开放文件描述把独占内核租约交给监督进程和直接 Runtime；关闭 Gateway 描述符不会释放继承的所有权。日志绑定节点、所有者、代次、凭据指纹、随机能力凭证、内核启动 UUID 和未被替换的锁 inode；已建立的控制端点与进程组身份不可更改。取消单独持久化，已停止代次不能重开。调用方取消覆盖准备与监督进程交接；新鲜压力准入在私有准备之后进行。描述符关闭失败时，必须确认进程清理或保留清理句柄。应用数据收集、清单接纳与迁移会拒绝包含本地监督记录、Gateway 模型锁或位于它们内部的根目录，包括管理员批准的根目录，恢复不能替换执行证据。

内核启动身份在 Runtime 分配前读取。macOS 原生探测使用五秒强制终止期限，将输出限制为1024字节，并排除 Gateway 凭据。启动取消信号保持关联，直到探测进程实际关闭；身份读取失败或取消都不能进入进程分配。探测关闭不能证明此前持有的 Runtime 已停止。

明确观测到不同的内核启动身份后，恢复允许重新挂载引起的设备号变化，但要求私有代次记录及锁文件 inode 保持不变。恢复重新取得当前独占锁，确认描述符仍指向该路径，再将当前设备标识写入终态记录。同次启动中的设备变化、inode 变化、锁被占用或启动身份探测失败都保留未确认占用。旧启动代次恢复不会访问保存的端点，也不会检查或向其进程组发送信号。

监督进程持有运行时输出流与经过认证的回环控制。它是活跃的 POSIX 进程组首进程，只向自身所属进程组发送信号。恢复控制器不会向从磁盘读取的数字 PID 发送信号。它重新取得精确内核租约，并观察进程组消失后，才提交或接受终态停止证据；不同的内核启动标识证明旧进程无法继续存活。元数据缺失、inode 替换、进程组仍存活或所有者不可达时，保留不确定占用。进程组探测遇到权限拒绝时同样保留占用：停止操作在既有期限内等待明确的消失证据，持续拒绝则报告终止未确认。进程组编号复用可能保守地延迟释放，但不会使信号指向其他进程。

本地恢复与正常关闭保留策略相互独立。`instancesOutliveGateway=false` 保留正常关闭时停止本地运行时的行为；管理器初始化接纳活跃分配，存活检查与热复用通过精确凭据接管，关闭还会处理从未读取过的已接纳分配。已经停止且没有保留预留的分配无需挂接进程。只读所有者查询、控制器挂接和监督探测失败时报告 `503 INSTANCE_UNAVAILABLE`，保留已记录的代次与占用；空闲租约与进程组消失的证据允许已退出的本地分配推进。Systemd 查询错误继续传播，除非 `is-active` 按 [systemctl](https://www.freedesktop.org/software/systemd/man/latest/systemctl.html#Exit%20status) 定义，以退出码 3 或 4 表示单元未活跃或不存在。它的[控制命令所有者](../bug-fix/2026-10-25-systemd-control-command-ownership.zh.md)单独限制 CLI 客户端，同时保留服务代次的不确定状态。

Linux 本地启动会实际探测用户级 systemd scope，再选择原生后代所有权。不可变预留记录 `nativeRange=linux-slice`；由 nonce 派生的 `dshruntime<去掉连字符的 nonce>.slice` 包含初始 Runtime scope 和所有从其中产生的进程。本地子进程提供方读取内核 cgroup 成员信息，把探测、pipe 和 PTY scope 放入相同 slice。SDK 启动进程时直接继承它，无需额外凭据或环境选择项。强制终止 slice 会覆盖独立进程组和已重新托管的后代。恢复除了要求内核租约空闲、原进程组消失，还要求整个 slice 为空；查询失败保留占用。监督进程失效后，恢复控制器可以停止由精确 nonce 派生的 slice，无需向磁盘保存的数字 PID 发送信号。停止空 slice 也会释放管理器中的状态。

## 考虑过的替代方案

**Gateway 退出钩子。** SIGKILL 会绕过它，无法建立可恢复所有权。

**持久保存 PID 并在重启后杀死它。** PID 复用可能使陈旧清理指向无关进程，发送信号由独立且活跃的首进程持有。

**HTTP 失败或保存的阶段为已停止时释放容量。** 两者都不能证明物理退出；内核所有权与所属进程组结束后才能释放。

## 后果

每个本地 Runtime 增加一个 Node 进程、一个回环监听器和私有代次记录。本机 macOS Node 25 下五次已编译启动器样本中，HTTP 就绪中位数从无监督进程的 86.59 ms 变为 224.97 ms；监督进程 RSS 为 78288 KiB。独立 Gateway 侧夹具 RSS 从 66848 增至 83728 KiB。RSS 包含共享页。旧编译基线未记录产物指纹，因此这些主机观测只作说明，不构成生产容量校准。压力准入观测主机用量，可选常驻上限仍相互独立。

替换发布和恢复应用数据时保留节点本地控制目录，且不要把它纳入自定义备份根目录。缺少精确所有权证据的旧分配需要独立确认停止。本地执行支持 macOS/Linux 内核锁。macOS、Linux 用户级管理器不可用，以及已有进程组预留，保留 POSIX 进程组保证；逃离进程组的后代仍不在其保证范围内。Windows 没有新增平台证据。Gateway 与受管电脑的写入者需要一同升级；原生所有权适用于新启动的分配，并要求匹配的子进程提供方。运行时诊断写入尽力而为，强制终止进程组可能中断缓冲写入。

## 验证

Linux 专用的 `test:built-local-native-supervision` 通过编译 Gateway、真实 Loader、pipe 与 PTY 提供方，以及公开 SDK 进程启动器，检查[稳定记录](../../../../gateway/tests/expected/local-runtime-native-supervision.expected.md)。它覆盖 Gateway SIGKILL、监督进程和根 Runtime SIGKILL、后代 scope 存活期间保留占用、精确恢复，以及公开所有者和代次相同的独立分配。SDK 夹具只回答传输握手；这是进程所有权证据，不是真实模型提供方验证。

真实源码启动与普通 Node 编译产物场景覆盖 Gateway SIGKILL、精确恢复、凭据隔离、终态围栏、排队取消、不配合退出的进程和继承输出管道的后代。内核测试覆盖 Gateway 描述符关闭后的继承所有权、inode 替换、有界私有记录与取消。PostgreSQL 验证物理退出后才回收恢复的占用。编译产物验收在已安装的 Node 22、24、25 上运行；`test:built-local-supervision` 检查其[稳定记录](../../../../gateway/tests/expected/local-runtime-supervision.expected.md)。

真实 PostgreSQL／Gateway／Web 配置装配验证经过认证的个人和共享项目访问、双成员复用、Gateway SIGKILL、精确代次恢复、监督不可达时不额外启动，以及替代 Gateway 的正常关闭。源码与编译启动器共用[预期记录](../../../../gateway/tests/expected/local-runtime-web-assembly.expected.md)；CI 在工作区消费者构建后运行编译场景。

只读[恢复清单验收](../../../../gateway/tests/fixtures/recovered-owner-liveness.mjs)使用 PostgreSQL、经过认证的 Gateway HTTP 和真实本地控制器。缺少挂接凭据与缺少所有者证据时返回不可用，已记录的代次和常驻占用保持不变。该恢复分配场景不启动原生 Runtime。
