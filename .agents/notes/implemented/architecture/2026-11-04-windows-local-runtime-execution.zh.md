# Agent Note：Windows 本地 Runtime 执行

状态：已实现

[English](2026-11-04-windows-local-runtime-execution.md) | 中文

## 问题

[Windows 节点接入](2026-11-04-windows-node-enrollment.zh.md)只放行了 `win32` 连通性并上报 `executionReady: false`：本地 Runtime 属主栈是 POSIX 专属。`LocalRuntimeOwnerStore` 靠继承描述符上的 `flock` 拿租约，`GatewayModelBudget` 用同一模式，supervisor 重新认领该描述符，配置路径校验直接拒绝 `C:\` 形式的根目录，而 generation 提交还对状态目录做 fsync（Windows 上 EPERM）。

## 决策

`executionReady` 现在是真实的按节点能力字段：连接载荷携带它（`z.literal(false)` 放宽为 `z.boolean()`），`node-access` 将其持久化到租约行，目录层返回它。节点仅在配置了 `localGatewayUrl` 时才上报——连通性绝不隐含执行权。

Windows 上的内核租约改用命名管道 `\\.\pipe\dsh-owner-<sha256(lockPath)>` 代替 `flock`：独占式命名管道监听、进程死亡时内核自动释放、无需继承描述符——supervisor 通过 `LocalRuntimeOwnerStore.adopt` 自行认领租约，因此 `win32` 下 `stdio` 不传 fd 槽位。`.lock` 文件保留为持久 inode 见证；NTFS 上 `stat.ino`/`dev` 是真实文件索引，见证相等语义不变。`EADDRINUSE` 映射到与 `flock` `EAGAIN` 相同的竞争路径。`GatewayModelBudget` 获得了相同的 win32 分支。

进程控制：`detached` spawn 仍可用，`process.kill(pid, 0)` 作为活性探测，组终止用 `taskkill.exe /PID <pid> /T /F`——Windows 没有进程组信号。启动标识通过 `localKernelBootId` 取 `Get-CimInstance Win32_OperatingSystem.LastBootUpTime`。

`config.ts` 的路径校验从硬编码 `posix.*` 改为平台别名（`isAbsolute`、`relative`、分隔符检查），使 `C:\harness-state` 这类根目录在 Windows 上通过校验，同时 `..` 逃逸检查继续生效。generation 提交改调 `syncStateDirectory`，它在 Windows 上空操作（NTFS 自身记录重命名；目录 `fsync` 返回 EPERM）——即 `node-private-file` 已在用的同一辅助函数。

## 备选方案

**保留 fd-4 描述符继承。** Node 在 Windows 上不会把任意 HANDLE 继承为 fd 槽位——实测探针报 `EBADF`——而 `stdio` 管道（fd 0-3 和 `ipc`）可以跨越，与凭证 fd3 通道的既有工作方式一致。

**基于 PID 的租约文件加活性轮询。** PID 复用加上轮询延迟使陈旧属主判定不可靠；命名管道提供与 `flock` 相同的内核持有、死亡即释放语义，且无需轮询。

**保留 POSIX 专属路径检查并对 Windows 特判。** 所有 `C:\` 根配置值都会校验失败；单一平台别名让全部十七处校验点保持一致。

## 影响

配置 `HGW_NODE_LOCAL_GATEWAY_URL` 的 Windows 节点上报 `executionReady: true`，通过节点服务流承接中心转发的 `?dshNode=`/`?dshRuntime=` 流量，分配托管 Runtime，并掌管其生命周期：启动、就绪、`taskkill` 树杀停止、generation 围栏（陈旧 generation 返回 `INSTANCE_GENERATION_CHANGED`）。已在生产中心对 Windows Server 2025 完成端到端验证：分配 → `observedState: "ready"` → 真实 headless 任务输出 → 停止 → generation+1 重启 → 陈旧 generation 拒绝。两个可选插件（`llm-pi-ai`、`session-telemetry-otel`）在载荷缺少其 npm 依赖时降级；`dsh web` 仍正常服务。

## 验证

在生产中心（release `coharness-full-real-20261104-r49-winexec`）对 Windows Server 2025 手工端到端验证：连接上报 `executionReady:true` 并持久化 `execution_ready=t`；转发的 admin 调用返回 `x-dsh-target-node`；`POST /admin/api/users/1/runtimes?dshNode=` 完成 Runtime 分配，`start` 到达 `ready`（确认 supervisor → `bin.js web` 进程树），`stop` 杀掉了进程树，`start` 产生 generation 21，陈旧 generation 的 stop 返回 `INSTANCE_GENERATION_CHANGED`。Gateway `tsc` 干净；原生测试车道负责持续覆盖。
