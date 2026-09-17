# Agent Note：串行创建等待预设工具安装

Status: implemented

[English](2026-09-18-serial-preset-installation.md) | 中文

## Problem

常驻模型选择预设在每个 Agent 的作用域内安装委派工具。Cordis 记录注入 fiber 的失败，但不会从 `inject()` 同步抛出。忽略该 fiber 会使 Agent 创建在工具注册冲突时仍然成功，绕过串行初始化的失败处理。

## Decision

[委派工具](../../../../packages/subagent/tool-subagent/README.zh.md)的作用域安装函数返回已有或新建的安装 fiber，并在 `agent/created` 中等待它。安装失败会在发布和输入准入前拒绝创建。Agent 注册表负责回滚，包括移除 Session 和释放预留 ID；消费者不增加第二套事务。

## Alternatives considered

- 只记录冲突而不拒绝创建，会接纳工具不完整的 Agent。
- 独立就绪标记重复表达安装 fiber 的结算状态，并可能遗漏已有失败 fiber。
- 修改 Cordis 注入语义会影响无关插件；等待消费者拥有的 fiber 保留上游生命周期模型。

## Consequences

预设重组仍然同步且幂等；只有串行创建等待安装。回归用例使用真实预设和冲突工具注册，验证创建拒绝、Agent/Session 注册表为空，再以相同 ID 重建并观察已安装的委派工具。不需要模型提供方或真实凭据。本次改动不改变 Session 格式版本或持久化代次。

产品 CLI 同样等待动态安装的监听依赖结算并通过激活审计，再开始监听配置层。Loader 条目创建本身不保证服务已经激活。产品 profile 快照保留成功、等待启动上下文、发布拒绝且未开始轮次，以及终止模型错误的断言。插入的 fixture 路径相对其 patch 文件解析；激活诊断保留原始错误并标明未激活条目。
