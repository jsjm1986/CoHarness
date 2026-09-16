# Agent Note：请求图像策略收敛为单一来源

状态：implemented

[English](2026-09-16-request-image-policy-single-source.md) | 中文

## 问题

`adapter.ts` 与 `request-pricing.ts` 各自携带一份 `resolveRequestImagePolicy`。pricing 副本不认旧别名 `imageDetail: 'low'`，因此同时声明数值 `imagePixelBudget` 与 `imageDetail: 'low'` 的模型在请求投影与定价估算下走不同预算——定价估算与投影的真实分辨率在同时设置两个开关的模型上发生分歧。

## 决策

`request-image-policy.ts` 现持有常量与策略函数；adapter 的语义——`imageDetail: 'low'` 作为低细节别名生效——是两个调用方共同导入的唯一权威实现。`request-pricing.ts` 为既有消费者 re-export 它。

## 考虑过的替代方案

**改以 pricing 副本为准（数值预算无条件优先）。** 否决：adapter 驱动真实请求投影，其语义定义正确行为；定价必须匹配请求的实际行为。

**保留两份并加注释。** 否决：造成此缺陷的漂移正是从"复制+注释"开始的。

## 后果

新增策略开关只有一个落点。定价投影与请求路径同样认可 `imageDetail: 'low'`。

## 验证

`adapter.spec.ts` 与 `request-pricing.spec.ts` 经两个消费方覆盖共享策略，包括此前发生分歧的 `imagePixelBudget` + `imageDetail: 'low'` 组合用例。
