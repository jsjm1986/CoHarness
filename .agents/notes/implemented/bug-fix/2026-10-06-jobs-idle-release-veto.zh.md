# Agent Note：任务在运行时否决空闲释放

状态：已实现

[English](2026-10-06-jobs-idle-release-veto.md) | 中文

## 问题

`tryDisposeIdle` 在回收空闲 Agent 前咨询 `agent/idle-release-check` 观察者（见 [idle 会话清理](../architecture/2026-09-27-idle-session-purge.zh.md)）。jobs 接缝没有安装观察者，因此后台任务仍在运行或停止中的 Agent 可能被空闲回收；该任务随后只因 owner 已不存在而以 teardown 结算。

## 决策

`dsh-jobs` 在 `JobRegistry` 构造函数中、归档准入旁，通过 `src/idle-release.ts` 安装该否决：当被询问的 Agent 拥有运行中或停止中的任务时（`job.owner === agent.id` 出现在 `registry.list(agent.id)` 中），`agent/idle-release-check` 回答 `busy`。无 owner 的任务不否决任何 Agent——它们属于服务本身直至释放。导出的 `runningJobs` 谓词让归档准入与空闲释放列出完全相同的集合。

## 曾考虑的替代方案

在 `agent-loop` 的释放路径中直接检查任务会在循环里硬编码一种资源类型，并绕过文档化的观察者扩展点。依赖 owner 释放去取消任务则会让空闲 agent 在工作仍存活时死亡——否决正是清理约定要求资源插件给出的答案。

## 后果

拥有存活任务的 Agent 永远不会被空闲回收；任务结算后否决即停止。`jobs-local` 测试覆盖运行中否决、结算后释放与无主任务情形。
