---
kind: upgrade-guide
description: "所有委派模型控制分类均包含父级执行权限，也覆盖仅安装执行权限的配置。"
---

# 子代理后端保留执行权限

[English](guide.md) | 中文

## 变更

已安装或必需的执行权限要求父级模型控制，即使没有模型访问策略和资源准入。ACP 和不透明 Claude Code 路径在原生分配前，以 `UNSUPPORTED_CAPABILITY` 拒绝一次性启动、成员创建和恢复推理。Codex 选择父级控制的 Responses 路由，保留允许的请求并拒绝被禁止的派发。此前仅安装执行权限的父级可能启动独立外部推理。

`requiresParentModelControl(ctx)` 统一该分类，供不透明后端拒绝、SDK 引导和原生 Codex 模型选择使用。提供方按需检查注册上下文和实际 Agent 上下文。

## 迁移

1. 一起重新构建匹配的 `dsh-subagent`、`dsh-subagent-codex` 和 `dsh-subagent-dsh-sdk` 产物，消费者需要共享导出。
2. 受管委派使用进程内后端、SDK 后端或兼容的已注册 Responses 路由。保持执行权限服务处于安装状态。
3. 自定义外部后端通过 `requiresParentModelControl()` 选择支持的父级控制，或通过 `assertExternalModelExecution()` 拒绝不受支持的推理。参见[子代理策略参考](../../../../packages/subagent/subagent/README.zh.md#delegated-policy)。
