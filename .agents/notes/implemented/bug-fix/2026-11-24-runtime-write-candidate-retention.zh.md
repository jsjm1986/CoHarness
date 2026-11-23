# Agent Note：访问失效保留 Runtime 写入坐标

状态：已实现

[English](2026-11-24-runtime-write-candidate-retention.md) | 中文

## 问题

`PostgresInstanceRepository.invalidateRuntimeTokenCache()` 在清除记忆化的凭据授权与在途查询时，一并清空了 `executionWriteCandidates`。该仓库把此方法订阅到了限定本节点的访问监视器（`gateway/src/index.ts`），因此每一次已应用的权限修订——在多电脑部署中 `LISTEN` 频繁投递修订事件的常态——都会丢弃全部已学习的个人与项目写入坐标。这些坐标的作用是让模型凭据端点在执行单条治理语句前选定正确的查找范围（`modelCredentialCandidate` 提供项目坐标，`personalExecutionCandidate` 提供个人坐标）；每次修订都清空它们等于让该特性形同虚设，并破坏了 `execution-runtime-isolation-postgres.spec.ts` 在三处断言的隔离契约。

## 决策

失效再次只丢弃 `tokenCache` 与 `tokenFlights`；`executionWriteCandidates` 作为查找范围提示跨权限修订保留。这是安全的，因为坐标本身从不授权：准入语句每次写入都会在 PostgreSQL 中重新核验精确的凭据、属主、节点与代次，过期的坐标至多浪费一次范围不准的查询，绝不会产生错误准入。卫星栈整合同期遗留的两处纯测试缺口也一并修复：provider 投影 fixture 仍在调用已被移除的 `runtimeProviders`/`runtimeProjectProviders` 服务方法，现已改为调用导出的 `runtimePolicyFromRows` 投影函数；三个 transcript fixture（`runtime-personal-policy`、`central-runtime-control`、`runtime-readiness-lifecycle`）此前会把 `[runtime-start-timing]` 诊断行泄漏进 stdout 快照，现已按既有的 `runtime-start-observation` 模式补设 `HGW_PERFORMANCE_ENABLED: 'false'`。

## 备选方案

- **保留清理并更新 spec**——在每次限定权限修订时丢弃坐标，恰好会在这些坐标本应存活的的事件流上抹掉它们；准入路径几乎每次模型调用都要付出范围发现查询，提示表却始终是空的。
- **区分失效种类**——把权限变更与生命周期停止分开处理能保住热路径上的坐标，但会引入第二套失效契约而无安全收益，因为坐标只是提示，准入无论如何都会重新核验。

## 影响

已学习的写入坐标跨权限修订保留，仍由准入时的实时 SQL 核验隔离；凭据授权仍被完全失效。provider 投影 fixture 现在驱动生产实现 `runtimePolicyFromRows`（连同 `RuntimePolicyRow` 一并导出），而非已不存在的服务方法；三个 transcript fixture 重新把 stdout 专用于其转录输出。
