---
description: "预编译 Landlock、异步 POSIX flock 与目录句柄的 JavaScript 入口。"
kind: "package-library"
---
# @deepseek-ai/node-addon-system

[English](README.md) | 中文

`./landlock-run` 入口导出 Landlock 启动器路径、强制执行探测、授权参数和协议常量。独立的 `./flock` 与 `./directory` 入口分别导出 `tryLockExclusive(fd): Promise<void>` 和 `DirectoryHandle`。导入入口不会加载 `system.node`。包不提供根导出。

`probe()` 默认使用2000毫秒期限，`timeoutMs` 可指定该期限。探测超时会强制终止并等待原生客户端关闭，再返回 `unusable`。客户端关闭不能证明内核支持相应能力，也不授权未隔离执行。

锁操作异步尝试 `LOCK_EX | LOCK_NB`。在完成前保持调用方拥有的描述符打开；竞争以 `EAGAIN`/`EWOULDBLOCK` 拒绝，其他系统调用失败也会拒绝，错误携带 code、值为正数的 errno 和 `syscall: 'flock'`。原生调用准备阶段的错误也会拒绝同一个 promise。关闭指向该打开文件描述的最后一个描述符即释放锁。绑定不打开、复制、关闭或显式解锁描述符。

`DirectoryHandle.open(path)` 拥有目录描述符；`openChild(name)` 打开一个真实子目录而不跟随链接，`read(count)` 以每批至多65,536项的方式流式读取，`createDirectory(name)` 使用保留的父目录。绝对路径打开仅拒绝末段链接；需要排除祖先替换的调用方应从文件系统根句柄开始逐段遍历。调用按顺序执行，`close()` 等待先前已接收的工作。子目录拥有独立描述符；调用方必须关闭每个句柄。参见[目录行为约定](../../docs/directory-contract.md)。

`volumeIdentity()` 在 macOS 上读取保留描述符所属文件系统的 UUID。其他 POSIX 平台及全零 UUID 返回缺失；原生调用失败会拒绝。持久化调用方仍须核验 inode 及目录归属。此操作要求同时使用匹配的 0.1.4 或更新版本 JavaScript 与原生载荷。

可选操作系统/CPU 平台包携带二进制。Linux 包含 `bin/landlock-run` 和分别用于两种 libc 的 `bin/glibc/system.node` / `bin/musl/system.node`；macOS 包含 `bin/system.node`。绑定缺失或无法加载时，锁获取或目录访问会被拒绝，不在安装时编译。Landlock 仍是遵循既有失败关闭协议的独立可执行文件；不支持的内核或平台探测结果为不可用。

三个 C 源文件随包分发以供审计。参见工作区[架构](../../docs/architecture.md)、[支持矩阵](../../docs/support-matrix.md)和 [CLI 约定](../../docs/cli-contract.md)。
