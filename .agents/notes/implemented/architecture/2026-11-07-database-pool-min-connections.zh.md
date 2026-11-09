# Agent Note:高 RTT 节点的 PostgreSQL 池最小连接数配置

状态:已实现

[English](2026-11-07-database-pool-min-connections.md) | 中文

## 问题

远程 Gateway 经 SSH 隧道访问中心 PostgreSQL,单语句往返 ~250ms。连接池(`max:10`、无 `min`)在 UI 突发之间退到零,于是每次突发都要为每条新连接付 ~1 秒建连(TCP+启动+认证往返),叠加在请求路径本有的串行语句成本之上。

## 决定

`HGW_DATABASE_MIN_CONNECTIONS`(默认 0,行为不变)经 [config](../../../../gateway/src/config.ts) 传给 `pg.Pool` 的 `min`,并在加载时校验 `min <= max`。由于 node-postgres 只会惰性维持 `min`,[index](../../../../gateway/src/index.ts) 启动时再做一轮检出即归还,把下限真正建起来。远程节点配 `HGW_DATABASE_MIN_CONNECTIONS=2`;中心网关 DB 在本地,保持默认。

## 备选方案

**调大 `idleTimeoutMillis`。** 池里空闲连接本就只有 30s;延长超时保留更多连接,但静默期下限仍会归零,也没有主动预热。

**先减语句数。** 串行往返的请求路径是已挂起的真实工作(见 `2026-11-06-governance-round-trip-collapse`);池预热与之互补,且不触碰授权语义即可落地。

## 影响

远程节点突发首延迟最多省 ~1 秒/条连接(下限以下)。每个远程网多空闲 2 条连接,对 DB 槽位影响可忽略。实测端到端延迟未变——剩余 ~6-10s 是已知的串行语句请求路径,仍需合并/断言式重构,而非池调参。
