# Agent Note：按路径拆分 Pull Request CI 门禁

状态：已实现

[English](2026-09-06-path-gated-pr-ci.md) | 中文

## 问题

每个 Pull Request 都会启动全量覆盖率、浏览器快照、发布形状运行时、Wine 和原生 Windows 门禁，即使改动只有 GitHub Action 版本或文档。稳定的 `all checks passed` 汇总也会把有意省略的任务当成失败，因此降低任务量必须同时调整汇总约定。

## 决策

CI 工作流新增轻量的 `pr-scope` 分类器。当 diff 只有文档，或只有工作流文件中的 `pnpm/action-setup` 版本替换时，将 Pull Request 标记为轻量变更。轻量变更保留静态分析、Node 兼容性和无密钥 Python SDK 检查；覆盖率、构建产物消费者、发布形状 Python 运行时以及两个 Windows 门禁会省略。所有源码、依赖、锁文件和工作流逻辑变更继续执行完整 Pull Request 门禁。

`all checks passed` 现在要求始终运行的静态、兼容性、Python SDK 和 scope 任务成功；只有 `pr-scope` 选择完整门禁时，才要求昂贵任务成功。有意省略的昂贵任务会作为带有明确 scope 原因的跳过结果处理，始终运行的任务被跳过仍会让汇总失败。

分类器在完整 checkout 后基于可信的 Pull Request 基线 SHA 运行。它是带单元测试的小型 TypeScript 模块，覆盖 Action-only、文档-only 和完整变更三种分类，不需要启动 GitHub Actions 才能验证分类逻辑。

## 结果

Action 版本和文档 Pull Request 不再分配耗时很长的覆盖率、浏览器、打包、Wine 和原生 Windows runner。产品、依赖、锁文件和工作流逻辑变更继续保留发布级验证。工作流仍然只暴露一个稳定汇总检查，并在汇总日志中记录是否启用昂贵任务及其原因。

## 测试

scope 分类器单元测试覆盖 Action-only、文档-only 和源码/依赖变更。CI 工作流契约测试覆盖 scope 任务、昂贵任务条件以及汇总依赖关系。后续 Pull Request 需要分别用轻量 diff 和完整 diff 通过 GitHub Actions 验证这项优化。
