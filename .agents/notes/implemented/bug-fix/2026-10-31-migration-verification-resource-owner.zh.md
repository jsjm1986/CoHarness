# Agent Note：迁移校验在排队期间保留准入归属

Status: implemented

[English](2026-10-31-migration-verification-resource-owner.md) | 中文

## 问题

历史 Session 发布需要等待提供者本地校验容量和节点进程准入。如果在第一层排队后才查询资源提供者，或在提供者变化后继续接受许可，校验线程可能在另一资源所有者之下启动。

## 决策

校验器在两层等待前捕获资源提供者，在每层等待结束后检查它，并在创建 Worker 前执行最后检查。Cordis 跟踪代理通过原始 Service 身份比较。提供者变化，包括进入或离开独立准入模式，均以 `ResourceAdmissionError` 的 `unavailable` 原因拒绝。未使用的许可归还原所有者。已经运行的校验及其终止继续履行原有记账责任。

## 考虑过的替代方案

**等待后接管当前提供者。** 这会将已经接收的请求转移给未接收该请求的所有者。

**替换后继续使用原许可。** 已移除所有者签发的许可不能授权当前组合中的新工作。

**每次提供者变化都取消已经运行的校验。** 等待分配需要当前授权；运行中的校验仍需要有序终止，并通过原所有者完成记账。

## 影响

写入打开失败会保留已提交的历史代次，不发布后继代次。准入恢复后可以重新发起写入打开。Session 格式、迁移阶段、配置和成功的 SDK 会话记录保持不变。[准备阶段决策](../architecture/2026-09-05-read-only-session-migration-preparation.zh.md)继续负责只读准备与不可变发布。

## 验证

单测覆盖两层队列、移除、替换、独立转托管和真实 Cordis Service 代理。[Loader 示例](../../../../packages/session/session-persistence-jsonl/tests/fixtures/migration-owner.mjs)使用真实 Worker Threads 打开历史会话进行写入，检查源字节未变且没有失败发布的后继，再成功重试。无密钥快照还覆盖未变化的托管准入和独立准入。
