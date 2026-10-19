# Agent Note: 驱动与 MCP 集成中的有界取消

Status: implemented

[English](2026-09-19-upstream-alpha2-use-drivers-sync.md) | 中文

## 问题

驱动与 MCP 集成将上游实现与分叉的 LLM 生命周期和包解析测试结合起来。忽略信号的 adapter 不能让已取消的 review 一直等待，合成解析夹具也不能仅为满足依赖分析而成为安装依赖。

## 决策

Auto review 使用 LLM 服务的有界流生命周期。取消结果与避免直接遍历 adapter 的理由由 [Auto review 决策](../feature/2026-08-28-auto-review.zh.md)维护。上游夹具必须经过该生产路径；夹具的信号处理方式不构成另一套取消策略。

依赖分析区分运行时解析清单与测试输入。Bundle 依赖可以提供仅由 Cordis 组合点名的包。相对地，app-boot 测试会刻意引用缺失或合成模块；[`knip.json`](../../../../knip.json) 中按该包限定的例外不创建生产依赖，也不放宽其他包的检查。

实验包发布遵循[共享发布策略](../process/2026-09-12-experimental-publication-denylist.zh.md)。[完整发布决策](../process/2026-09-12-publish-all-experimental-packages.zh.md)拥有空的私有排除清单。同一策略适用于 driver 与 MCP 包。

## 考虑过的替代方案

**只采纳上游断言，不核对其执行路径。** 绕过 LLM 服务的夹具不能证明经过该服务的生产 review 会得到什么结果。集成测试必须保留实际的取消所有者。

**将合成 profile-resolution 夹具名称声明为依赖。** `metadata-lib`、`#missing`、`./relative.cjs` 等说明符是刻意选择的测试输入。安装它们会改变测试所覆盖的条件，并错误描述运行时包需求。

## 后果

上游同步保留运行时取消所有权，并区分已安装包与合成解析输入。依赖例外限定在拥有它们的测试或解析清单中。Benchmark 可用性与构建验证遵循当前仓库配置，而非历史导入清单。

## 验证

[Auto review 测试](../../../../packages/experimental/auto-review/tests/auto-review.spec.ts)覆盖调用方取消后迟到的 provider 结果。[推送前检查选择流程](../../../skills/dsh-pre-push-checks/SKILL.md)按实际待发布差异选择依赖、构建与驱动测试。
