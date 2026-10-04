# Agent Note：为既有重复代码基线设置上限

Status: implemented

[English](2026-09-02-bounded-duplication-baseline.md) | 中文

## Problem

仓库重复代码门禁使用了 `exitCode: 1`，却没有为 jscpd 配置阈值。该选项会使命令在发现任何 clone 时失败，包括 `origin/master` 已经存在的 clone 组，所以即使拉取请求本身没有新增重复，也无法通过该门禁，除非同时重构大量无关的历史代码。

## Decision

`.jscpd.json` 设置仓库级重复行阈值 `0.09`%，并移除无条件的 `exitCode` 选项。实测重复率超过阈值时，jscpd 仍会以非零状态退出。当前基线继续完整显示在控制台报告中；`scripts/duplication-config.spec.ts` 会固定这条狭窄上限，并防止“只要存在 clone 就失败”的模式重新出现。

该阈值只略高于源码实测比例——在 476,391 行分析结果中有 420 行重复，约为 0.088%。它是回归预算，不表示现有每一组 clone 都合理。消除具体 clone 会降低实测比例，并使维护者能够有意下调上限。

有两个配置细节决定了这一上限如何达成。`ignore` 字段以文件 glob 形式排除 `**/tests/**` 与 `**/tsdown.config.ts`，确实生效。散落在源码中的 `/* jscpd:ignore-start */ ... /* jscpd:ignore-end */` 注释标记则无效：jscpd 5.x 没有标记机制，而此前继承的 `ignorePattern` 正则位于 glob 字段中，永远不可能匹配源码文本。被标记的重复区域无法豁免；只有真正共享代码才能降低实测比例。

## Alternatives considered

**继续要求零重复，并在本次 CI 修复中重构全部 34 组历史 clone。** 不采用，因为这会把广泛的产品代码重构混入基础设施变更，显著增加审查和回归风险。

**在阈值之外继续保留 `exitCode: 1`。** 不采用，因为 jscpd 会把该选项视为“发现任何 clone 即失败”，使阈值无法成为可运行的基线边界。

**完全禁用重复代码失败。** 不采用，因为后续重复代码增长将无法使必需 consumer 通道失败。

## Consequences

拉取请求会依据一个可运行且有上限的基线接受判断，不再面对无法满足的零 clone 状态。只要变更使重复行比例超过 0.09%，CI 就会失败。控制台报告会继续列出每一组 clone，维护者可以逐步降低基线。降低实测基线的改动必须在同一拉取请求中同步下调阈值。

## Testing

真实 jscpd 命令在当前 0.088% 基线和 0.09% 上限下成功退出，超过该上限时以非零状态退出。配置测试验证检入的边界，consumer CI 通道则执行完整仓库扫描。
