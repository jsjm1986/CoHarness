# Agent Note: 精确 ID 运行时目录解析的突发记忆化

Status: implemented

[English](2026-11-07-catalog-exact-id-resolve-memo.md) | 中文

## 问题

远程 Gateway 经 SSH 隧道访问中心 PostgreSQL,单条往返约 250 ms;而一次转发请求会多次解析同一个运行时环境:node-service 代理在校验 placement 时调用 `resolveForAccount`,`/api` 分发器在分发前又对同一 id 解析一次。按每次 catalog 查询约 270 ms 计,重复解析是每次远程调用的纯延迟;浏览器的一次突发(对同一 runtime 的 `workbench-rows`、`workspace.list`、`session.list`)还会逐请求重复。

## 决策

[resolveForAccount](../../../../gateway/src/postgres/runtime-catalog.ts) 对*成功*的解析结果做 800 ms 记忆化,键为 `actor.id` + 环境 id,并发调用共享同一个在途 promise,map 上限 512 条。错误一律不保留:失败的 load 只删除自己的条目,因此拒绝与授权变更对下一个请求立即可见。

仅精确 id 解析被记忆化。`resolveForOwner`、`resolveForLanding`、全部 `pageFor*` 列表以及 `resolveForAdministrator` 仍然每次调用都查询:选择器歧义与落地排序必须在下一请求就观察到新增环境——目录规格测试 `enters a stable authorized personal default...` 证明了这一点,它要求在第二个个人环境出现后立刻返回 409。

## 为什么精确 id 解析可安全记忆化

- 解析结果中的身份字段(owner、node、runtime id)在实例活跃期间不可变——schema 检查约束拒绝 owner/node 重分配(`rejects forged identities, changed owners and reassignment of an active process`)。
- 退役最多被掩盖 ≤800 ms,且下游 attach 路径以活跃实例行与 generation 做栅栏(`beginStart` 返回 `unavailable`),过期正结果永远不可能对已删除的 runtime 发起执行。
- 授权丧失在同一有界窗口内生效,与现有 TTL 先例一致(`authenticateRuntimeToken` 见证缓存、300 ms 维护门缓存)。

## 已否决的替代方案

**记忆化全部选择器。** 否决:`resolveForOwner` 的歧义检测必须看到并发插入的环境,缓存会在 TTL 内掩盖它。

**仅请求级记忆化。** 需要把请求作用域穿过代理与分发器逐层传递;突发窗口以单点改造同时覆盖了请求内去重与跨请求扇出。

**合并 `validateSession` 的两条语句。** 仍然否决——续期 `FOR UPDATE` 加锁后重读是 `auth-postgres.spec.ts` 明确断言的撤销可见性契约。

## 后果

每次远程转发请求省一次 catalog 往返(隧道节点约 270 ms);浏览器突发中每次重复解析再省一次。placement 元数据最坏 800 ms 过期,而下游栅栏本就会重验。远程请求路径上剩余的串行链(`owner()`、实例状态、资源预留、`record_runtime_activity`)是已记录的后续项——合并它需要 generation 栅栏分析,不在本次范围。
