# Agent Note：按路径拆分 Pull Request CI 门禁

状态：已实现

[English](2026-09-06-path-gated-pr-ci.md) | 中文

## 问题

每个 Pull Request 都会启动全量覆盖率、浏览器快照、发布形状运行时、Wine 和原生 Windows 门禁，即使改动只有 GitHub Action 版本或文档。稳定的 `all checks passed` 汇总也会把有意省略的任务当成失败，因此降低任务量必须同时调整汇总约定。

## 决策

CI 工作流新增轻量的 `pr-scope` 分类器 [`scripts/ci-pr-scope.ts`](../../../../scripts/ci-pr-scope.ts)。只含文档的 diff 会省略与其无关的 runtime 与 platform 消费者；所有无法识别的输入默认进入完整 lane 库存，安装器版本号改动则获得其 workflow 所有者选中的 runtime 与 platform proof lane（见[受控的依赖升级](2026-10-08-controlled-dependency-upgrades.zh.md)）。

[`scripts/ci-pr-scope.ts`](../../../../scripts/ci-pr-scope.ts) 生成与提交绑定的验证计划。`all checks passed` 任务使用 [`scripts/verify-pr-results.ts`](../../../../scripts/verify-pr-results.ts)，要求每个被选中的任务成功，并允许有意省略的任务。

scope 命令在完整 checkout 后，以 GitHub Pull Request 事件提供的基线 SHA 计算改动路径。默认的 `shadow` 执行取冻结分类结果与候选分类结果的并集；显式的 `candidate` 策略使用候选计划。本地测试无需 GitHub Actions，即可验证纯文档、安装器以及源码和依赖的分类。

## 考虑过的替代方案

**每个 Pull Request 都运行完整门禁。** 这种方式最统一，但会让不影响产品行为的改动也占用最长时间的 runner。分类器对源码、依赖、锁文件和工作流逻辑变更仍保留完整门禁。

**只用工作流触发器的文件过滤。** 这样可以阻止整个工作流启动，但会让必需检查消失，也无法保留稳定的汇总结果。scope 任务让每个 Pull Request 都保留同一个工作流和汇总检查。

**信任 Pull Request 提供的基线或分类结果。** 这种方式允许分支修改分类输入，因此拒绝。分类器在完整 checkout 后使用事件提供的可信基线 SHA 计算 diff；无法识别的变更默认进入完整门禁。

**文档或 Action 版本变更完全跳过检查。** 这种方式会失去对工作流和打包回归的廉价防线，因此拒绝。轻量路径仍然必须通过静态、兼容性和无密钥 SDK 检查。

## 结果

文档 Pull Request 不再分配耗时很长的覆盖率、浏览器、打包、Wine 和原生 Windows runner。无法识别的输入以及产品、依赖、锁文件、安装器和工作流逻辑变更继续保留计划选中的发布级验证。工作流仍然只暴露一个稳定汇总检查，并在汇总日志中记录是否启用昂贵任务及其原因。

## 测试

scope 分类器单元测试覆盖文档-only、安装器和源码/依赖变更，CI 工作流契约测试覆盖 scope 任务、昂贵任务条件以及汇总依赖关系。本地覆盖只验证分类与结果准入约定；被选中 job 在真实 runner 矩阵上的实际通过仍由 CI 侧证明。
