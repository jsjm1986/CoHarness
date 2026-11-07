# Agent Note:节点租约与控制通道授权收敛为单条 SQL 函数

状态:implemented

[English](2026-11-07-node-lease-control-functions.md) | 中文

## 问题

`heartbeat()` 与 `authorizeChannel()` 每次调用都跑同一段串行事务:`BEGIN`、部署拓扑门(仅心跳)、对节点代理行 `FOR UPDATE`/`FOR SHARE` 加锁并对组织行 `FOR SHARE`、可选续期、`COMMIT` —— 每次四到五个往返。在隧道节点上每个 RTT 约 270ms,因此一次心跳持锁并占用池连接约 1.1s 而实际工作只有约 270ms;通道授权则是每条控制消息调用一次。维护事务对池连接的占用让浏览器请求排在节点流量之后。

## 决策

迁移 123 新增 `harness.node_channel_lease` 与 `harness.node_heartbeat`(`VOLATILE SECURITY INVOKER`,`search_path=pg_catalog`)。每个函数在客户端视角的一条语句内完成拓扑门、凭据查找、行锁、分类检查和续期(仅心跳),返回 `jsonb` 状态载荷。`PostgresNodeAccessService` 每次操作只发一条池查询,并把载荷映射回既有的 `NodeAccessError` 错误码;请求 schema 仍在调用前校验。[共享节点通道授权](../bug-fix/2026-10-31-node-channel-shared-authorization.zh.md)的共享锁模型不变:`authorizeChannel` 对代理行保持 `FOR SHARE`,`heartbeat` 保持 `FOR UPDATE`。

被保留的不变量及其新位置:

- **错误分类与顺序**:未找到 → `401`、`detached` → `409`、吊销/凭据不符 → `401`、过期/连接/纪元不符 → `409 lease-lost`、拓扑门 → `409 mode-disabled`(心跳先查拓扑,与原来 `primary(tx, false)` 先于 `authenticate` 一致)。
- **两段式"先身份后锁"**:凭据哈希查找在锁前快照上解析出 `node_id`,加锁读按 `node_id` 连接,因此并发清除或替换 `credential_hash`(如 detach)不会改变行身份,等待后的最新行版本参与评估;随后重检锁定行的 `credential_hash`。单条 `WHERE credential_hash=$x FOR SHARE` 无法表达这一点 —— PostgreSQL 在锁等待结束后会用最新行版本重评 WHERE,行会消失。
- **锁后租约新鲜度**:`lease_expires_at <= clock_timestamp()` 在加锁 `SELECT … INTO` 返回后的 `IF` 中求值。把 `clock_timestamp()` 放进加锁 SELECT 的目标列表会在锁等待结束前计算,可能把已过期租约误判为存活;原 `target/locked` CTE 依赖的是同一"外层时钟在锁后"的顺序。
- **原子"检查并续期"**:心跳 `UPDATE` 在 WHERE 中保留 `lease_expires_at > clock_timestamp()`,过期租约仍不能被迟到心跳复活。
- 连接 `connection_id`/`connection_epoch` 比较使用 `IS DISTINCT FROM`,与原先含 NULL 的 `!==` 语义一致。

## 备选方案

一并合并 `connect()` 被否决:它频率低且带 attachment、纪元递增、拓扑 revision、忙态分支,复杂度与省下的 RTT 不成比例。合并 `validateSession` 的两条语句被否决:第二条读故意在会话锁释放后的新快照上重检权限。授权结果的客户端缓存被共享授权 note 的不缓存决策否决。

## 影响

每次心跳与通道准入现在付一次往返而非四五次;WAN 链路上的行锁持有时间约缩短 4 倍,池连接更快回到请求工作。SQL 函数复制了服务的检查顺序,未来错误分类变更必须在同一发布中同时更新函数和剩余事务用户(`connect`、`disconnect`、`release`)。语句级捕获验证需要重置库级 `log_statement='none'` 并终止池内后端,因为库级默认值在池会话建立时固化。

## 验证

`gateway/tests/node-access-postgres.spec.ts`(26/26):两个操作的单往返语句计数断言;六种权限变异场景(吊销、过期、凭据替换、detach、纪元替换、组织禁用)全部经锁等待重查路径验证;锁释放后观察到租约过期。回归套件(runtime-catalog、computer-access、auth、deployment-topology)全绿;typecheck 与构建干净。生产:约 3 分钟内 46 次 `node_heartbeat` + 75 次 `node_channel_lease` 执行,全部为无事务包裹的单条语句;三节点全程 `active`、心跳新鲜;经公网站点对 Ubuntu 节点发真实 prompt 获得模型回复。
