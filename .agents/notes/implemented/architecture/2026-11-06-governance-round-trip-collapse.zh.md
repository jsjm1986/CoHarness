# Agent Note：为隧道节点收敛串行治理往返

Status: implemented

[English](2026-11-06-governance-round-trip-collapse.md) | 中文

## 问题

远程节点网关经 SSH 隧道访问中心 PostgreSQL,RTT 约 200ms，有两条热路径把 RTT 乘以语句数。每轮 `NodeResourceBudget.observe` 以约 7 条串行语句跨链（事务、`lock_node_resources`、时钟读取、观测更新、条件调度、提交），每节点每约 10 秒的采样就在隧道上消耗约 1.4 秒。每次 `authenticateRuntimeToken`——runtime→gateway 内部 API 调用每次都会触发——执行一次 6 表 JOIN 加两个权限函数，每节点约每秒一次；连同后台轮询挤满节点连接池，把 `ubuntu-101` 上的用户请求推高到 8–16 秒。

## 决策

**服务端观测轮次。** 迁移 `121_observe_node_resources.sql` 新增 `harness.observe_node_resources(tenant, computer, sample, elapsed_ms, initial_limits)`：在一次调用内完成资源行插入或加锁、过期排队请求清扫、陈旧采样拒绝、按采样与已存 limits 重算 credits、条件调度。`NodeResourceBudget.observe` 现在把 `performance.now() - capturedAt` 作为 `elapsed_ms` 传入；函数叠加自身入口到持锁的等待，使在锁队列中等待期间过期的采样照旧被丢弃。函数顶部的 `set_config('lock_timeout', statement_timeout, true)` 在该调用隐式事务内复刻客户端包装器 `lockWait: 'statement'` 的锁等待边界。

**Runtime token 鉴权缓存。** `PostgresInstanceRepository` 以 `sha256(token) + cleanup` 为键、短 TTL(`HGW_RUNTIME_TOKEN_CACHE_MS`，默认关闭，网关显式开启）记忆 `authenticateRuntimeToken` 结果，含单飞去重与有界 LRU。`harness_access_invalidation` 通知经既有监听通道到达各网关并清空缓存；token 签发/撤销写路径在提交时同步清缓存。`runtime_node_execution_allowed` 以 `node_connection_epoch` 绑定节点授权，节点重启即更换 epoch，使缓存项与 TTL 无关地失效。

## 备选方案

**先合并整个请求解析链。** /account/api/context 链路是 session→user→scope→runtime→admission 的数据依赖读，逐端点合并有收益，但采样循环与 token 见证流会持续乘算 RTT。观测轮与 token 见证无条件运行且频率高于任何单端点，故先行收敛。

**中心签发的授权断言。** 目标节点验签代替查询。这仍是计划的下一步，但需要信任注册表：各网关目前持有独立 Ed25519 密钥对（`principal.ts`)，在公钥经 PostgreSQL 分发之前中心签的断言节点无法验证。本次两项改动与该协议无关并先行拿到大部分延迟收益。

**无失效通道的更长 token TTL。** 否决：撤销必须以通知速度而非 TTL 速度传播，故缓存订阅既有 access-invalidation 通道而非延长陈旧窗口。

## 影响

生产环境以 `log_statement='all'` 窗口实测：三节点全部发出 `observe_node_resources` 调用（服务端 1.5–3.5ms)，旧语句链归零；Ubuntu 池上 token 见证执行数下降约 75%。`windows-vps-47` 的 `/account/api/context` 中位数降至约 46ms 节点段；`ubuntu-101` 仍约 6 秒——其请求路径的串行读与后台轮询仍在乘算 200ms RTT，合并它们是后续工作。

语义由 `tests/node-resource-budget-postgres.spec.ts`(65/65）保持：锁等待期间过期的采样被丢弃、statement 级锁等待边界不变、竞争仍映射 `503 database-busy`、告警绕过采样节奏闸门、有序见证继续拒绝较旧采样。两个测试装置按单调用形态重写：schema 影子 `clock_timestamp` 探针改为延迟派发池代理，`performance.now` mock 过期测试改为真实持锁超过 50ms `staleMs`。
