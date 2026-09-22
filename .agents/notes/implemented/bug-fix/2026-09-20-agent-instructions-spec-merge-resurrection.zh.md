# Agent Note：修复 agent-instructions spec 的合并复活

Status: implemented

[English](2026-09-20-agent-instructions-spec-merge-resurrection.md) | 中文

## 问题

`agent-instructions` 的 `src/` 与上游 `dsh-v0.1.6-alpha.2` 逐字节一致——包括 `renderAgentInstructions` / `renderAgentInstructionSet` 新名——而 `tests/agent-instructions.spec.ts` 仍在导入改名前的 `renderWorkspaceContext` / `renderWorkspaceInstructionSet`。该 spec 还保留了上游早已迁入 `dsh-agent-loop-testkit` 的手写 inbox 辅助层，导致 154 个测试中 84 个失败，host 聚合类型检查报未解析导入。一次合并把仍带旧名的上游分支 spec 盖回了改名提交的 spec 半边，而 `src/` 半边保留，文件自此长期不一致。

## 决策

整体采用上游 alpha.2 的 spec 与 e2e，而不是逐段修补复活文件：`src/` 已与上游完全一致，上游测试对就是权威契约。包清单补上上游测试真正需要的导入——`dsh-agent-loop-testkit` 与 peer/dev `dsh-session-projection`——外加 `src/files.ts` 此前一直靠传递提升解析的 `dsh-util-values` 运行时依赖，并在 `tsconfig.json` 补上 `session-projection` 项目引用。

## 已考虑的替代方案

**就地修补复活的 spec**（改符号名、保留手写 inbox 辅助层）。否决：该文件的行为期望同样陈旧——84 个失败并非全部源于缺导出——逐个修补得到的仍是未验证的分叉猜测而非契约。

**删除陈旧 spec。** 否决：baseline 组合与 inbox 同步的全部覆盖都在这个文件里，删除会让 workspace-context 接缝完全无测试。

## 影响

`packages/context/agent-instructions` 不再残留任何分叉 spec 文本；后续上游 spec 更新可干净合入。任何本地行为变更现在必须显式同步修改 `src/` 与 spec，而不是靠陈旧副本静默分叉。

## 验证

`pnpm exec vitest run packages/context/agent-instructions/tests/agent-instructions.spec.ts` —— 155/155 全绿。`pnpm exec tsc -b tsconfig.host.json` 不再报告 `agent-instructions` 错误。
