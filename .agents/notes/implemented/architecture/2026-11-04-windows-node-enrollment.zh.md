# Agent Note：Windows 节点接入

Status: implemented

[English](2026-11-04-windows-node-enrollment.md) | 中文

## 问题

[多电脑设计](../../proposed/architecture/2026-10-28-multi-computer-personal-runtimes.zh.md)将 Windows 节点整体延后：接入、探测和目录 schema 仅接受 `darwin`/`linux`，代理进程在其他平台直接退出，而凭证与连接状态检查依赖 POSIX 权限位和 `getuid`——这些在 Windows 上不存在。

## 决策

`win32` 成为第三个受支持的节点平台。接入、租约、心跳、断开与控制通道原样运行；线协议与身份模型本身与平台无关，改动集中在平台 schema、代理的私有文件边界和一条 PostgreSQL 检查约束。接入仍报告 `executionReady: false`：已连接的 Windows 节点只证明连通性，Windows 本地 Runtime 执行、服务托管与资源压力采样仍是独立工作。

`gateway/src/node-private-file.ts` 统一持有两平台的私有状态边界。POSIX 保留现有的句柄内检查（`mode & 0o077` 加 `uid === getuid()`）；Windows 通过有界 PowerShell `Get-Acl` 探针评估文件 ACL，仅接受调用方 SID 与 `S-1-5-18`/`S-1-5-32-544`（LocalSystem 与 Administrators——属主访问的操作系统边界等价物），任何 Deny 或外来 Allow ACE 一律拒绝。`O_NOFOLLOW` 在 Windows 上无效，因此先用 `lstat` 复查路径是否为重解析点；新状态文件在原子重命名后用 `icacls /inheritance:r` 收紧。目录 `fsync` 在 Windows 上失败（EPERM），该耐久性刷盘在 Windows 上跳过——NTFS 日志本身覆盖重命名。

## 备选方案

**继续拒绝 `win32`，直到 Windows 执行栈完整落地。** 仅连通节点是协议本就承载的合法中间态（`executionReady: false`）；拒绝接入只会推迟控制面、凭证生命周期与 ACL 边界的真实验证，而拒绝模型本就隔离它不具备的任何能力。

**把 Windows 文件私有性交给用户配置目录继承。** `%USERPROFILE%` 的 ACL 默认私有，但对放在其他位置的文件无效（`HGW_NODE_AGENT_STATE_FILE` 可配置）。显式 ACL 检查加重命名后收紧，在任意路径上都保持与 0600 相同的属主边界。

## 影响

Windows x64/arm64 电脑可以接入、持有租约、响应控制通道探测，并在配置后转发现有 Gateway 服务。`deploy/windows/node-agent-task.ps1` 将编译入口注册为 `HarnessNodeAgent` 计划任务（SYSTEM、开机启动、失败重启），`GatewayNodeConnection.start` 分发 `schtasks /Run`；本地 Runtime 监督／属主路径、内核启动身份与压力采样仍为 POSIX 专属，继续隔离真实执行。`node-agent.ts` 与 `node-connection.ts` 共用 `node-private-file.ts`，私有文件契约保持单一实现；Windows 私有性锚定文件属主 SID 加 SYSTEM 与 Administrators 而非读取者账号，使运维写入的配置文件对 SYSTEM 托管的 agent 依然私有。

## 验证

`tests/node-private-file.spec.ts` 覆盖两个分支：POSIX 按权限位接受／拒绝；Windows 接受收紧后的 ACL、拒绝放宽的授权、符号链接路径与已消失的文件。`tests/node-access-postgres.spec.ts` 断言 `freebsd` 仍被拒绝而 `win32` 可接入。一台 Windows Server 2025 主机对运行中中心完成了端到端：`enrolled` → `connected`（`executionReady:false`）→ `channel-ready`，心跳续订 30 秒租约，管理员发起的探测回传 `platform:win32/architecture:x64`；强杀 agent 后租约自然过期，凭持久化凭证重连时 epoch 递增。CI 的 `windows-native` 车道负责持续覆盖。
