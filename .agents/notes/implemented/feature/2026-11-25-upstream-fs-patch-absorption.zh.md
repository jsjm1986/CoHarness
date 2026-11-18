# Agent Note：上游 fs-patch 吸纳

状态：已实现

[English](2026-11-25-upstream-fs-patch-absorption.md) | 中文

## 问题

上游 rc.3 的 apply-patch 功能需要 Codex 风格的 patch 解析器与 LF 文本更新器，但本地树没有等价原语，apply_patch 工具没有它无法落地。

## 决定

原样吸纳上游 `packages/fs/fs-patch`（dsh-v0.2.2-rc.3）：一个纯 patch 解析器（`parsePatch`）与 LF 文本更新器（`applyHunks`），带结构化匹配失败、零运行时依赖。该库已在 `tsconfig.host.json` 与 fs 组 README 包表中登记。

## 后果

- `dsh-fs-patch` 作为库包交付，由 [fs 变更词汇与 apply_patch 批](2026-11-25-upstream-fs-mutations-and-apply-patch.zh.md) 消费：`fs-local` 的 `patchText` 与 `apply_patch` 工具建立在 `parsePatch`/`applyHunks` 之上。
- 解析器强制 LF 输入，并以 hunk 与行上下文报告 `ParsePatchError`/`ApplyHunksError`；调用方将其作为结构化工具输出呈现。

## 备选方案

- **只手工移植 hunk 应用半边**——拒绝：解析器与更新器在同一结构化失败约定上互锁，且该文件不依赖 `ctx.fs`、cordis 运行时或提供方，逐文件整体吸纳无移植风险。

## 验证

- `pnpm exec vitest run packages/fs/fs-patch` —— 147 个测试通过（上游测试套件未改动）。
- `pnpm exec tsc --noEmit -p packages/fs/fs-patch/tsconfig.json` —— 干净。
