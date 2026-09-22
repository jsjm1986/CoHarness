# plan/ — plan collaboration state

English | [中文](README.zh.md)

Plan mode is logged, per-agent collaboration state rather than a generic mode registry or capability seam.

| Package | Role | ctx key |
|---|---|---|
| [`plan-mode/`](plan-mode/README.md) | Owns plan-mode state, guidance, commands, and review flow | `ctx.planMode` |

The [plan-specific collaboration state](../../.agents/notes/implemented/simplification/2026-07-22-plan-specific-collaboration-state.md) decision records the family design.

The subsystem reference — the `plan/mode` fold, the step-boundary flush, configuration, the exit tool — is [docs/subsystems/plan.md](../../docs/subsystems/plan.md); design in [plan-specific collaboration state](../../.agents/notes/implemented/simplification/2026-07-22-plan-specific-collaboration-state.md).


## Summary

The `plan/` group provides plan mode: while it is active, the agent explores and designs before executing, guided by instructions the deployment writes, and presents the finished plan for your approval before carrying it out. You can enter and leave plan mode with the `/plan` command and approve the plan or send the agent back to keep planning. Plan mode guides rather than restricts: every tool stays available, and limits such as sandbox mode and approval prompts are configured separately. The group contains one package, `plan-mode`.
