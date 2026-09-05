# Agent Note: 首次完整 coverage 暴露的债务采用只缩减基线

Status: implemented

[English](2026-09-02-first-run-coverage-baseline.md) | 中文

## 问题

必需的 coverage 通道对每个被测量的 package source 文件强制要求 statements、branches、functions 和 lines 全部达到 100%。第一次在标准托管 Runner 上完整运行时，文档、协作、Gateway、LLM、session、SDK、浏览器和 subagent 表面暴露了已有债务；在仓库迁移到可移植 Runner 的过程中，门禁无法把新覆盖代码与这些既有缺口区分开。

## 决策

`scripts/coverage-baseline.ts` 以字面路径记录当前仍未覆盖的 source 文件，在其余仓库继续保留每文件 100% 门槛。该清单只允许缩减：`scripts/coverage-baseline.spec.ts` 拒绝 glob、重复条目、package `src` 树之外的路径和过期路径；每次偿还债务时，必须连同补充测试一起删除对应清单行。清单从唯一的根 `vitest.config.ts` coverage 排除列表引入，因此 CI 分区和本地聚焦 coverage 使用同一份库存。

该基线是债务台账，不是降低全局阈值。清单之外的文件继续受所有门槛约束；新 source 文件不能在没有明确审查、所属测试和文档说明的情况下加入基线。

## 曾考虑的替代方案

**降低全局阈值。** 不采用：百分比会同时掩盖既有缺口和新引入缺口，失去能够定位下一项修复的逐文件信号。

**排除整个 package 或宽泛目录 glob。** 不采用：文档和协作 package 中同时存在已覆盖文件与债务，宽泛排除会抹掉有效证据，也无法测量后续缩减。

**在所有历史缺口修完前保持必需通道为红。** 不采用：在偿还债务期间，可移植 CI 无法为无关变更提供可合并信号；显式清单让其他文件保持严格门槛，并让偿还过程可审计。

## 后果

必需 coverage job 可以报告当前变更，而不会把历史债务误判为全仓失败。代价是维护有限清单并逐文件偿还；新增清单条目必须有记录的理由和对应的缩减路径。

## 测试

清单单元测试与受影响 package 测试一起通过，coverage 配置直接消费导出的清单。相关聚焦测试覆盖 settings 注册与销毁、本地 jobs 保留策略、LLM adapter 与 discovery、session persistence、subprocess 行为和 workflow session 处理，然后才发布基线。
