# Agent Note: 在每个 PostgreSQL checkout 入口执行接纳限制

Status: implemented

[English](2026-10-23-postgres-checkout-admission.md) | 中文

## 问题

Gateway PostgreSQL 调用方使用 `pool.query()`、promise 和 callback 两种 `pool.connect()`，以及事务辅助函数。仅在 `connectFromPool()` 内执行 `maxCheckoutQueue`，会使原生 query 及直接 checkout 绕过相同资源上限。过载时，有界事务路径可以与无界原生待决队列并存，其观测等待数因此无法描述整个 pool。

## 决策

[createPostgresPool()](../../../../gateway/src/postgres/database.ts) 返回真实 `pg.Pool` 的内部子类，在 `connect()` 重载处统一拥有接纳计数。原生 `pg.Pool.query()` 实现调用该方法，因此 query、promise checkout、callback checkout 和事务辅助函数共享一个上限。pending 包含建连中和等待空闲 client 的操作，不包含已完成 checkout 的 client。Pool 大小、语句执行、release、超时和事务行为仍由 pg 拥有。

超过上限的 promise 以 `DB_CHECKOUT_QUEUE_FULL` 拒绝；callback 异步收到相同错误。成功或失败后，接纳计数在通知调用方之前释放。原生同步失败会回滚接纳计数；promise 调用方收到 rejection，callback 调用方保留 pg 的同步抛错行为。Pool 开始关闭后，pg 自身的关闭后使用结果优先于接纳拒绝。

成功的原生 checkout 为每个 client 仅附加一次现有的 metadata-only checked-out client 错误保护。对于 Gateway 创建的 pool，`connectFromPool()` 直接委托，事务调用方因此只消耗一个接纳名额。其现有 fallback 为辅助函数调用方接纳外部注入的 pool，不修改外部所拥有 pool 的原生方法。[poolAdmissionSnapshot()](../../../../gateway/src/postgres/database.ts) 返回当前 pending、配置上限和累计拒绝次数，不含 SQL、凭据或账户标签。它与 pg 原生 waiting count 分开，因为建连中的操作也消耗接纳名额。

等待连接时取消会立即拒绝事务。取消后晚到的 client 只归还一次，不会执行已取消的事务。

[Gateway 观测决策](../testing/2026-10-23-gateway-performance-observation.zh.md) 拥有进程/请求指标及离线 HTTP 基线。Checkout 接纳改变过载行为，并限制保留的需求量；它不证明 PostgreSQL 持续吞吐提高，也不构成多人容量结论。

HTTP 请求拥有方将该接纳错误映射为 503。用量接收端在鉴权与入账阶段保留该拒绝的可重试状态，因此有效用量记录会由发送方继续保留，不会被归类为 400 输入错误。

## 已考虑的替代方案

**包装每个服务的 `query()` 调用。** 不予采纳，因为新增调用方或重载可以绕过包装，且每个服务都将拥有接纳职责。pg 共享的原生 checkout 方法已经覆盖其 query 实现。

**在 pg 前面添加第二个队列。** 不予采纳，因为两个独立等待队列会模糊超时及释放职责。接纳计数直接拒绝多余需求，不另行实现调度器。

**增大 PostgreSQL pool。** 不予采纳为接纳限制的替代品，因为连接数不能限制待决调用方，还可能加剧数据库争用。连接及队列上限需要各自的部署证据。

## 后果

每个生产 checkout 都参与相同的未完成操作上限。调用方可能收到明确过载错误，而不是进入不断增长的等待队列；重试和面向用户的状态策略归请求拥有方负责。活跃 query 和已 checkout 的事务 client 仍受 pg pool 大小及现有语句、锁、空闲事务超时约束。原生 pool 状态与 Gateway 接纳状态保持独立可观测。

## 验证

[无密钥回归套件](../../../../gateway/tests/pool-admission.spec.ts) 通过可控 Client 实现驱动真实 pg pool，不建立数据库 socket。覆盖原生 promise 及 callback query 入口、直接 checkout 重载、辅助函数共享接纳、异步拒绝、容量恢复、建连失败、constructor/query 同步失败、fake-clock checkout 超时、关闭错误优先级以及 checked-out 错误保护。Query 溢出回归在仅辅助函数限流的实现上失败，因为多余原生 query 会成功，而不是收到 `DB_CHECKOUT_QUEUE_FULL`；统一 checkout 拥有方后通过。这些测试证明队列语义与失败清理，不证明 PostgreSQL 吞吐。
