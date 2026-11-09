# Agent Note: 本地 Runtime 属主存储在有界窗口内重放 Windows ACL 判定

Status: implemented

[English](2026-11-06-owner-acl-verdict-replay.md) | 中文

## 问题

Windows 上的每次 `LocalRuntimeOwnerStore.read` 都通过 spawn `powershell.exe` 来解析属主目录和记录文件的 ACL 私有性——两个子进程，在生产节点上每次读取约一到两秒。该读取在每个代理请求的 `LocalRuntimeControl.isAlive` 内运行，因此在节点请求路径的其余部分降到几十毫秒后，探测成了 Windows 上剩余的主要开销。POSIX 从 stat 元数据免费得出同样的判定。[Windows 本地 Runtime 执行](2026-11-04-windows-local-runtime-execution.zh.md)栈让这些读取成为热路径，却没有改变其探测成本。

## 决策

[node-private-file.ts](../../../../gateway/src/node-private-file.ts) 中的 `privateFileState` 和 `privateDirectoryState` 接受可选的 `WindowsAclProbe`——一个 `(file, signal) => Promise<PrivateFileState>` 判定解析器，默认是导出的 `probeWindowsAclPrivate`，即真实的 PowerShell spawn。委托点位于每次调用都执行的 `lstat` 与 reparse-point 检查之下，因此解析器能摊销的只有子进程本身；POSIX 调用点在读到该参数前就已返回。

[local-runtime-owner.ts](../../../../gateway/src/local-runtime-owner.ts) 中的 `LocalRuntimeOwnerStore` 注入按实例的解析器。属主目录在 `PRIVATE_ACL_CACHE_MS`（10_000）未到期前重放已提交的 'private' 判定。记录文件仅当刚打开文件的 stat 身份——`mtimeMs`、`ctimeMs`、`size`——仍与取得该判定时一致才重放，因为 republish 会就地重命名一个新文件，在新 inode 上沿用旧判定正是危险窗口。'unreadable' 和 'not-private' 从不重放：失败在下一次调用重新探测，检查保持 fail-closed 且无恢复延迟。

因此陈旧性上界只覆盖：文件或目录本身不变、但其 ACL 被外部改动的情况，最长十秒。记录仍在每次调用中被打开、字节被读取、schema 被解析、generation 身份与 capability 被比对、lock-inode 见证被重新校验。ACL 判定守护的是静止存放的记录控制承载凭证；证明记录属于本 generation 的每请求围栏不变。

## 备选方案

**重放整个判定，包括 lstat 与 mode/uid 检查。** 否决：整体跳过 `privateFileState`/`privateDirectoryState` 会丢掉 Windows 上每次调用的 reparse-point 检查，还会改变 POSIX 行为——其 mode/uid 判定免费且保持每次调用执行。

**模块级或按路径共享的缓存。** 否决：共享状态会比它描述的存储实例活得更久，还可能跨 generation 与调用方泄漏判定；按实例字段随存储消亡，不携带任何跨边界状态。

**记录判定改用 inode 而非 stat 身份做键。** 否决，无必要：`mtimeMs`/`ctimeMs`/`size` 在每次 republish 重命名时都会变化，且每次调用都从已打开句柄读取，无需额外 stat；身份不变即观测到的元数据不变。

## 影响

此前每个代理请求要付出一到两秒 PowerShell 的节点，现在每十秒窗口只付一次；`acquire`、`acquireExisting`、`cancel` 及 publish/恢复路径的读取共享同一实例的重放。代价是一个有界的陈旧判定窗口——对未改动对象新加的外部 ACL 授权最长十秒内仍可能读作 'private'——之所以接受，是因为记录字节、capability 与 lock-inode 围栏保持每请求执行，且该判定守护的是 loopback 承载凭证的存放，而非承载交换本身。

## 验证

`local-runtime-owner-acl-cache.spec.ts` 在 `win32` 平台伪装下统计 `runGatewayChildCommand` 调用：三次读取每个探测各 spawn 一次，重命名替换的记录文件触发文件重探而目录不重探，'not-private' 判定从不重放且下一次读取即恢复，mock 的 `Date.now` 确认重放恰在上界结束。
