# Agent Note: 独立审查驱动的节点、部署与管理面硬化

状态：已实现

[English](2026-11-07-independent-review-hardening.md) | 中文

## 问题

对当前分支的多角度独立审查（Windows 节点/部署、管理端与远程桌面 UI、节点租约并发面、postgres 服务层）在交付路径上确认了多个真实缺陷：Win32 错误码在错误的线程上读取、对端转发断言接受非有限时间戳与可重放的 nonce、`schtasks /end` 可能让持有控制租约的节点 agent 成为孤儿、管理端界面渲染裸机器错误码、租约 SQL 函数的成功载荷被盲目信任、`recoverSteward` 在文档要求的 advisory-lock 临界区之外分配端口、steward dry-run `EXPLAIN` 可被引导成 `EXPLAIN ANALYZE` 真实执行从而绕过审批门与读通道 deny-list、`node_channel_lease` 缺少 `node_heartbeat` 具备的部署拓扑门。

## 决定

**Win32 errno 诚实性。** [directory-move-win32.ts](../../../../packages/attachment/userdoc-local/src/directory-move-win32.ts) 改为同步调用 `CreateFileW`/`GetFileInformationByHandle`/`MoveFileExW`：`call.async` 在 koffi 工作线程上执行，而回调运行在 JS 线程，`GetLastError` 读到的是陈旧的线程局部状态，所有失败都坍缩为 `EIO`，破坏 `store.ts`/`mutation.ts` 的 `EEXIST`/`ENOENT` 恢复分支。[windows-inspector.ts](../../../../packages/subprocess/subprocess-local/src/windows-inspector.ts) 为每个 `koffi.alloc` 在 `finally` 中配对 `koffi.free`，对齐 `win32-process` 的 `freeNative` 所有权惯例。

**转发断言。** [forwarded-principal.ts](../../../../gateway/src/forwarded-principal.ts) 要求 `issuedAt`/`expiresAt` 通过 `Number.isSafeInteger` 校验（此前 `Infinity` 过期时间能通过 `typeof` 检查而永不过期），`index.ts` 持有调用方所有的 nonce 台账（按 nonce 键控、带 TTL 修剪的 `Map`，无模块级状态），被捕获的断言无法在 TTL 内重放。`server.ts` 注释现在明确 `x-dsh-target-node` 只是客户端可伪造的路由标记，而非到达证据。第二轮审查发现已验证断言是 **bearer 凭证**:`currentUser` 在完全没有会话 cookie 时也会接受它，因此在 TTL 内被捕获的断言可在每个网关本地端点（含 `/account/password`）以 `claims.user` 全权操作。`issueForward` 现在签发 `request` 绑定——方法、pathname 与 `sha256(sessionToken)`——`forwardRequestMatches` 仅在三者全部与到达请求一致时接受；`x-dsh-target-node` 仍是路由标记而非证据。绑定前签发的断言缺少 `request`，以 fail-closed 落入普通会话校验，滚动部署保持兼容。`NodePrincipalDirectory.issuerKey` 的记忆化上界改为同查询读出的租约截止时间，喷射压力下逐出最旧条目而非清空整表；nonce 台账的保留过期钳制到 `principalAssertionTtlMs` 并设 4096 上限；非 `/api` 路径上被接受的转发（`/api` 车道下游会重新校验会话）写入一条携带 `issuerNode`+`nonce` 的 `auth.forwarded` 审计行，对等断言发起的变更可归因。对等私钥仍按节点持久化——怀疑密钥泄露的修复路径是吊销凭证并删除 `principalKeyDir`，使新密钥对重新发布。

**租约载荷边界。** [node-access-service.ts](../../../../gateway/src/postgres/node-access-service.ts) 的 `acceptedLease` 通过 `leasePayloadSchema` 可判别联合校验 `node_heartbeat`/`node_channel_lease` 的 JSON 输出，取代 `as` 断言；畸形的 `ok` 载荷抛出普通 `Error`，而不是伪造 `node-access/<垃圾>` 错误码或因 `new Date(undefined)` 抛 `RangeError`。迁移 `126_channel_lease_topology.sql` 为 `node_channel_lease` 增加 `computer uuid` 参数并施加 `deployment_topology` 门（mode-disabled 组织不再能凭未到期租约授权通道），并将 `projects_steward_per_node` 收窄为 `status='active'` 行，归档 steward 不再毒化对应节点的重播种。该门不能照搬 `node_heartbeat` 的"仅主节点"形态：`node_channel_lease` 同时服务每个二级网关 service 桥的节点本地 `/internal/nodes/service` 身份核验，因此 `127_channel_lease_local_gateway.sql` 在调用方为拓扑主节点**或** agent 所属本机时放行——外来计算机仍为 `mode-disabled`。`issue()` 把 `node_agents` 主键竞争失败的 23505 映射为 `node-access/name-conflict` 而非裸违规。

**Windows 任务宿主。** [node-agent-task.ps1](../../../../gateway/deploy/windows/node-agent-task.ps1)：`-Restart` 在 `/end` 后清扫存活 agent 进程，因为 Task Scheduler 只终止被跟踪的 `powershell.exe`——但仅当目标任务的动作托管 agent（`Test-HostsAgent` 要求 `-Run` 调用形态，重启 watchdog 或兄弟任务不会误杀存活 agent），清扫（`Sweep-AgentOrphans`）按命令行匹配 `node-agent-main.js` 并以任务的 `-GatewayDir` 限定范围，不再按 `node.exe` 名称过滤，定制的 `-NodeExe` 或幸存的 `cmd.exe` 垫片也能命中，同机第二份安装不受影响；确认停止后再扫一次（启动中的垫片可能在首扫与停止落地之间才拉起 agent);`-Uninstall` 在 `Unregister-ScheduledTask` 之前执行同样的 `/end`+清扫（注销从不终止运行中的实例，否则被卸载的 agent 会作为无监督孤儿继续心跳持租约直到重启）。watchdog 与 `-Restart` 的竞态中，停止后回到 Running 视为成功；`-Install` 断言 `$PSCommandPath`、绝对化并创建 `StateRoot`/`LogFile`/`ConnectionFile` 父目录、`AlsoWatch` 按 `[,;]` 分割裁剪，并拒绝落入 `cmd /c` 引号中的名字与路径里的 `"`/`%`;env 文件先按 UTF-8 读取，无法解析时以 BOM 自动探测回退 UTF-16，剥离一层配对引号，并在单元自身赋值之前应用以对齐 systemd 优先级；agent 日志每次启动按 10 MB 轮转，watchdog 日志每轮按 1 MB 轮转；校验 `schtasks /run` 退出码；`node-connection.ts start()` 传 `-NonInteractive`;`validate_release` 要求该脚本存在。

**Runner 活性。** [windows-job.ts](../../../../packages/subprocess/subprocess-local/src/windows-job.ts) 的 `WindowsJobOwner.signal` 为 terminate IPC 加 5 秒 `RUNNER_TERMINATE_TIMEOUT_MS` 上限；已连接但事件循环卡死的 runner 会被杀死，使 Job 关闭时清扫其进程树（断连路径已由 `releaseOwnedJob` 兜底）。统一的 `failAndKill` 守卫避免发送回调、同步抛错、超时三条路径重复报告失败。

**管理端文案纪律。** `PeerBackupSection` 将全部 118 条文案迁入 [peer-backup.copy.ts](../../../../gateway/admin-ui/src/pages/peer-backup.copy.ts)（`zh` 为准字典 + `en` `Record<PeerBackupCopyKey, string>` + 经 `translateCopy` 的 `{name}`/`{count}` 占位符），把 `PeerRecoveryActions` 的 `problem()` 映射并入共享 `message()`，两条错误通道得到一致的本地化文案，裸码兜底替换为本地化的 `unrecognizedOutcome`。`RemoteDesktopPage` 通过 `ERROR_KEYS` 映射全部 `remote-desktop-*` 错误码族及认证/维护码，`timeLabel` 本地化，`changeLevel` 加 `busy` 门槛，非法保存不再静默忽略而是显示 `endpointInvalid`。`NodeAccessSection` 新增 `modeDisabled`/`notFound`/`nodeDetached` 映射，把"更多已部署电脑"按钮移出 `Field` 的 label，两个区块的 `randomUUID` 改用 `dsh-util-crypto`（`crypto.randomUUID` 在非安全来源上不存在）。

**Steward 服务面。** `recoverSteward` 在 `allocateInstancePorts` 前先取 `pg_advisory_xact_lock(hashtext('gateway-port:<node>'))`，与所有其他分配调用点的文档化临界区一致；缺锁时恢复若与普通分配竞争，会在 `instances_assigned_node_id_port_key` 上落败并连带中止整个挂载复活事务。`stewardTarget` 额外绑定 `steward_node_id` 到本网关节点，其他节点 steward 的令牌不再被本网关接受。`explain()` 发出 `EXPLAIN (ANALYZE OFF)`：显式选项列表之后语法要求 ExplainableStmt，载荷开头的 `ANALYZE`（过去会把语句拼成 `EXPLAIN ANALYZE` 从而在无审批、无 deny-list 的情况下真实执行内层语句）现在只是规划期语法错误；`READ_LANE_DENY` 对 dry-run 预览与真实执行同样生效，拒绝入账时记录 dry_run 标志。

**杂项。** `instances.ts` 以 `0600` 播种 `.env`；`login()` 对不合格尝试校验固定合法的 `DUMMY_PASSWORD_HASH`，响应时间不再泄漏用户名是否存在；`config.ts` 在加载期就拒绝永远无法归一化的 `HGW_STEWARD_PROJECT_NAME`/`HGW_COMPUTE_NODE_NAME` 组合；`restore-check.sh` 要求绝对 dump 路径（`-f` 在 `cd` 前校验而恢复在 `cd` 后读取）；`backup-postgres.sh` 追加 `-$$` 后缀，同秒两次运行不再互相覆盖 dump；`node-agent.ts` 注明 `executionReady` 报告的是已配置的桥接端点而非探测结果；`windows-inspector` 文档化 identity 校验与 taskkill 之间的 TOCTOU 界限。

## 已考虑的替代方案

**Koffi async + 手工错误捕获。** koffi 的 async 路径不提供逐调用的 last-error 通道，同步调用是诚实的修法；三个系统调用都是本地快速调用。

**对未映射码直接拒绝而非通用兜底。** 对 worker `error_code` 长尾保留本地化通用文案可维持操作者信任，而具体可操作的码仍逐一映射。

## 影响

Win32 目录移动失败现在能到达调用方实现的 `EEXIST`/`ENOENT`/`EACCES` 分支；转发断言带有限生命周期与一次性 nonce；`schtasks /end` 不再遗留仍在心跳的孤儿进程；管理端横幅不再渲染机器码；租约函数输出在数据库边界经契约校验。`verify-client-ui-i18n` 不扫描 `gateway/admin-ui`；该目录的双语对齐门是 `Record<keyof typeof zh, string>` 类型。

## 验证

- `forwarded-principal.spec.ts` 新增非有限时间戳的伪造断言用例及 request 绑定覆盖（方法/路径/会话哈希匹配、改写请求与缺失 cookie 拒绝、旧格式断言 fail-closed);`node-access-postgres.spec.ts` 27/27 覆盖 schema 校验后的租约路径及迁移 127 的本机/外来计算机门用例；`server.spec.ts`/`proxy.spec.ts`/`html.spec.ts` 在 currentUser 转发接受改造下保持绿色；`runtime-request-path.spec.ts` 覆盖两个 scope 端点的 `isExplicitScopeRequest`(`/account/runtime/start` 表单路径现与 JSON 路径同样经过 `assertPlacementComputer`);`subprocess-local` 454/454 覆盖 inspector/owner 修改及两个新增假时钟用例（卡死 runner 强杀与结算后不误杀）；`steward.spec.ts` 24/24 覆盖 dry-run `ANALYZE` 前缀拒绝与预览 deny-list；`runtime-management-postgres.spec.ts`/`project-service-postgres.spec.ts` 132/132 保持 steward 恢复路径绿色。
- `node-config-process.spec.ts` 在分支上持续失败：fixture 的 bootstrap admin 保留 `must_change_password`，而 `lockAdministrator` 要求合格凭证；fixture 在就绪后将播种管理员标记为已改密（2/2）。`node-agent.spec.ts` 按 agent 实际实现的 `already-connected` 可恢复拒绝语义更新（32/32）。
- `gateway`、`gateway/admin-ui`、`subprocess-local`、`userdoc-local` typecheck 干净；`node-agent-task.ps1` 通过 `System.Management.Automation.Language.Parser` 解析；admin-ui vitest 567/567。
- Mac release 已重新同步（`lib/` + `deploy/` + `public/admin/`），网关重启后运行硬化构建；迁移账本已记录 123–127 版本且校验和一致。Windows r54 经 SSH 获得同一载荷；`-Restart -TaskName HarnessNodeGateway` 在真机上验证兄弟任务重启不动 agent 进程（`$hostsAgent` 门），`-Restart -TaskName HarnessNodeAgent` 重新获取租约（epoch 40）。
