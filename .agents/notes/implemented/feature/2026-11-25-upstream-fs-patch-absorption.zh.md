# Agent Note: 上游 fs-patch 吸纳

[English](2026-11-25-upstream-fs-patch-absorption.md) | 中文

Status: implemented

## 决策

原样吸纳上游 `packages/fs/fs-patch`（dsh-v0.2.2-rc.3)：一个纯 Codex 风格 patch 解析器（`parsePatch`）与 LF 文本更新器（`applyHunks`)，带结构化匹配失败，零运行时依赖。

## 理由

该库完全自包含——不依赖 `ctx.fs`、cordis 运行时或提供方——逐文件整体吸纳无移植风险，并为 fs 功能批依赖的 apply_patch 原语落地（上游 `tool-fs` 的 `apply_patch` 管线构建于其上）。本地 `ctx.fs` Service Definition 目前不提供 move/delete/patch 操作，因此在 apply_patch 工具落地前该库暂无消费者；已在 `tsconfig.host.json` 与 fs 组 README 包表中登记为库包。

## 验证

- `pnpm exec vitest run packages/fs/fs-patch` —— 147 个测试通过（上游测试套件未改动）。
- `pnpm exec tsc --noEmit -p packages/fs/fs-patch/tsconfig.json` —— 干净。

## 遗留

- apply_patch 工具与 `ctx.fs` move/delete/patch 操作：仍属 fs 功能批，待 Service Definition 变更。
