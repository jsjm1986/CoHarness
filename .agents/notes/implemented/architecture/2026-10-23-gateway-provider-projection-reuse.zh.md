# Agent Note: Gateway Provider 投影的查询内复用

Status: implemented

[English](2026-10-23-gateway-provider-projection-reuse.md) | 中文

## 问题

PostgreSQL 运行时策略查询将每个启用的模型与其 Provider 连接，因此 Provider 的完整 JSON profile 会出现在每个模型行中。逐行克隆、移除旧版明文密钥并查找配置模型列表，会让重复工作随单个 Provider 的模型数呈平方增长。受管 Runtime 使用前的治理准备包含这段投影，热复用也会经过它；只优化进程启动仍会把这些工作留在请求路径中。

## 决策

复用只属于 [PostgreSQL 治理服务](../../../../gateway/src/postgres/model-governance-service.ts) 的单次查询结果。组织和项目投影分别为每个 Provider 规范化一次 profile，并建立一次配置模型索引。重复模型 ID 保留首个条目，与既有有序查找一致。Provider／模型顺序、项目路由前缀、内嵌端点规范化及旧版密钥移除保持不变。

后续策略读取会从自己的数据库行重新构造投影。不引入进程级或跨请求缓存：模型授权、配置 revision 和凭据更新必须保留原有的观测时点。[Provider 归属决策](../feature/2026-08-17-organization-model-provider-ownership.zh.md)、[项目设置决策](../feature/2026-08-28-project-scoped-settings-management.zh.md)和[策略在线重载决策](../feature/2026-08-14-gateway-model-governance-live-policy-reload.zh.md)继续分别拥有权威来源和发布规则。

## 已考虑的替代方案

**跨请求缓存完整 Provider 投影。** 否决，因为 Provider 身份本身不能标识当前配置或授权 revision。这种优化需要显式的 revision 栅栏、失效机制和保留所有权；消除已读取结果内部的重复行处理不需要引入这些机制。

**只规范化一次，仍为每个模型查找配置数组。** 否决，因为这仍保留平方级查找工作。调用内索引消除重复查找，显式保留首个条目的规则则维持重复 ID 的行为。

## 后果

投影克隆和模型索引的工作量与配置 profile 及返回模型数呈线性关系。临时索引为每个不同的配置模型增加一个条目，投影构造完成后便不可达。返回的 profile 仍保留完整配置模型数组。PostgreSQL JOIN 传输和 JSON 解码仍逐模型行重复 profile；本决策不减少这些数据库或网络工作。

## 验证

[定向测试](../../../../gateway/tests/runtime-provider-projection.spec.ts)覆盖两种作用域、每 Provider 一次克隆、重复 ID 取首项、元数据与密钥移除、格式错误的存储 profile、Provider 隔离及后续读取采用更新后的 profile。工作量断言在未优化实现上失败：分别有 16 和 8 个模型的两个 Provider 会克隆 24 份 profile，而不是两份。

构建当前 Gateway 源码后，在仓库根目录运行 `npm exec -- tsx gateway/tests/runtime-provider-projection.perf.ts`。[诊断](../../../../gateway/tests/runtime-provider-projection.perf.ts)以合成 JOIN 行调用真实构建产物中的投影，不使用数据库、凭据、监听器或模型调用。源码编排驱动构建模块；诊断记录工作量，不记录执行时间。

| 每 Provider 模型数 | Profile 克隆次数：基线 → 复用 | 被克隆模型条目：基线 → 复用 |
|---|---|---|
| 16 | 16 → 1 | 256 → 16 |
| 64 | 64 → 1 | 4,096 → 64 |
| 256 | 256 → 1 | 65,536 → 256 |

组织和项目投影在 Node 25.8.1、macOS arm64 上都产生这些计数。它们证明局部重复工作被移除，不能证明完整空间切换延迟、整机容量或支持 300 人在线和 100 个混合任务。数据库解码、认证、网络、Runtime 就绪和浏览器渲染均被排除。[Gateway 观测决策](../testing/2026-10-23-gateway-performance-observation.zh.md)继续拥有部署测量的限制说明。
