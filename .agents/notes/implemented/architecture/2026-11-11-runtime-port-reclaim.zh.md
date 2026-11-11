# Agent Note: 实例端口冲突自愈

Status: implemented

[English](2026-11-11-runtime-port-reclaim.md) | 中文

## Problem

每个实例在分配时获得一个节点本地固定端口，spawn 前从不复核。被 SIGKILL 的 supervisor 留下孤儿子进程占着端口，下一代进程 `EADDRINUSE`，在就绪期限内死亡并无限重试——某项目行因此堆到 generation 11228。同一循环也卡死 `LocalRuntimeControl.confirmStopped`：孤儿进程组被永远报为 'occupied'。

## Decision

两层各做一次证据有界的修复：

- **`confirmStopped` 孤儿回收**(`local-runtime-control.ts`):POSIX 下，当记录绑定的 `groupPid` 组仍存活但 leader(supervisor 本身）已死时，幸存成员是本 generation 自己的孤儿——存活进程组不可能混入外来成员，且 pgid 由本记录的 spawn 产生。回收在**两处**运行：获取租约失败时（孤儿子进程继承了 supervisor 的 lease fd，supervisor 死后锁仍被持有）与已持锁的确认内部（不持 fd 的孤儿），且仅作用于**当前内核 boot** 的记录——更早 boot 的记录可能跨越机器重启幸存，其登记的 pgid 在 PID 复用后可能指向无关进程组。对该组 `SIGKILL` 并重新探测，而非永远报 'occupied'。Windows 已有按父链扫孤儿；linux-slice 不变。
- **启动时端口回收**(`instances.ts`):`beginStart` 消耗 generation 之前，`reclaimInstancePort` 探测 `127.0.0.1:{port}`。拒连或被立刻丢弃的连接视为空闲——这同时覆盖 fixture relay：它接受连接转发给真实子进程，无上游时直接销毁空探测。任何回包字节、或 1s 期限仍被持有的连接计为占用。到达此处的行必为 `stopped`，其凭证哈希已被 `markStopped` 清空，因此按构造不存在可归属占用者的 owner 证据——占用者必然在我们的证据之外。`repository.reassignPort` 随后分配新端口（至多 3 次，每次重新探测）。未实现 `reassignPort` 的仓储让启动响亮失败，而不是在就绪期限内空转 `EADDRINUSE`。
- **`stopping` 残留补完**(`reconcile`):gateway 重启丢弃进行中的终止，行永远卡在 `stopping`（收养的租约随后以 'incomplete start or stop' 挡住启动）。reconcile 探测在按 runtime 串行的车道上按行内**已记** `stop_reason` 完成终止，并以观测到的 generation 为围栏——竞争中的替代启动不会被取消或停止；`manual`/`access-change` 保持不回温；空 reason 记为 `failed`。

`reassignPort` 有 PostgreSQL(`pg_advisory_xact_lock` + `allocateInstancePorts` + `UPDATE instances.port`，按 `public_id`/`runtime_id` 寻址）与 SQLite（事务内 `MAX(port)+1`）两种实现。端口是节点局部寻址而非身份，重分配安全；客户端按 public id 解析 runtime。

## Alternatives considered

**PID 检查（`lsof`/`netstat`）识别并杀死占用者**。否决：平台相关、解析脆弱，且对任何外来进程下 kill 裁决都需要比端口绑定更强的证据——gateway 选择改址而非裁决。唯一合法的 kill 目标是本 generation 自己的孤儿，已由 `confirmStopped` 通过记录绑定的 pgid 证据处理。

**经 owner 证据重连 stale 持有者**。曾实现后移除：到达此代码的行必为 `stopped`,`markStopped` 已清空 `runtime_token_hash`，认证本 generation 持有者所需的凭证在此处从不存在——该分支在生产上不可达，只有一个对 `credentialHashOf` 打了桩的测试让它看似生效。

**仅裸 connect 探测**。connect 通过无法区分 fixture relay 监听（预期持有者，转发给真实子进程）与占位进程。被丢弃的空探测信号正是同一份代码同时服务生产与 relay fixture 的关键。

## Consequences

kill -9 supervisor + 残留子进程型崩溃循环在两个独立点自愈：任何终止尝试中 `confirmStopped` 回收孤儿组；`reclaimInstancePort` 在 spawn 前改址端口。外部进程占位不再让实例死锁——实例迁往新端口并保持 `ready` 语义。残余缝隙：接受连接后立刻丢弃空探测的占位者会被判为 'free'，子进程随后 bind 失败仍经正常就绪期限暴露，并由 reconcile 失败退避兜底。

## Verification

- `instances.spec.ts`：占用分配端口的外部监听器经 `reassignPort` 绕过，runtime 在新端口到达 `ready`;`reassignPort` 返回 `undefined` 的仓储让启动以 'cannot be reassigned' 失败且行保持 `stopped`；卡住的 `stopping` 行经 generation 围栏的串行车道按已记 reason 补完。
- 生产 mac-mini r57：对 supervisor `50219` 执行 `kill -9` 留下孤儿 `50222`（被 launchd 收养，持有 `42016` 端口**及继承的 lease fd**)；修复版 gateway 启动后 reconcile 补完卡住的 `stopping` 行——`reapOrphanedGroup` 对组 `50219` SIGKILL，租约释放，行落定 `stopped`/`failed`，随后在同一 `42016` 端口回温至 `starting`。两行同端口（`42000` 本机 vs 远程节点）本机探测正确判空闲——端口身份是节点局部的。
