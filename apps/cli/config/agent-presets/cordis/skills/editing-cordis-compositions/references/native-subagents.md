# Native product subagents

Codex and Claude Code providers are independent optional Profile Bundles. Install only the products a Profile needs, then restart the Profile so its Host registers those providers:

```sh
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-codex
dsh plugin --profile <name> add @deepseek-ai/dsh-subagent-claude-code
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-codex
dsh plugin --profile <name> remove @deepseek-ai/dsh-subagent-claude-code
```

Each Bundle owns its Host availability; the preset separately grants one Agent its ordinary delegation tool. Never move a product provider into the preset and never add a product-specific settings field. Removing one package withdraws only that provider on the next Profile start.

Copy these disabled templates from a shipped full preset and remove `disabled` only for the products the user requested:

```yaml
- id: tool-subagent-codex
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: codex
    toolName: subagent_codex
    backgroundMode: one-shot
    maxDepth: provider-managed

- id: tool-subagent-claude-code
  name: '@deepseek-ai/dsh-tool-subagent'
  disabled: true
  config:
    provider: claude-code
    toolName: subagent_claude_code
    backgroundMode: one-shot
    maxDepth: provider-managed
```

For additional named Codex or Claude Code instances, mount a separate host-plane provider row for each instance with a unique `providerName`, then add a separate preset tool row whose `provider` exactly matches that name and whose `toolName` is also unique. Keep the shipped rows for the default `codex` and `claude-code` names; do not reuse one tool row for several providers or derive either name from permission or environment settings.

The two rows are independent. Leaving both disabled preserves the copied preset, enabling one exposes only that product tool, and enabling both exposes both. Production `dsh` does not install either optional provider: before enabling a row, install the matching `@deepseek-ai/dsh-subagent-codex` or `@deepseek-ai/dsh-subagent-claude-code` Bundle in the Profile and restart it. Each Bundle registers its dormant default provider and exclusively uses its pinned package-local platform CLI; additional named instances use extra host-plane rows from the same installed package. A preset cannot provide that host dependency. `backgroundMode: one-shot` keeps omitted or `false` calls in the foreground and lets explicit `run_in_background: true` return a generic Job id. Full presets already carry `tool-jobs`, while the base host carries the job registry; retain both so `job_output`, `job_list`, `job_kill`, cancellation, and completion notices stay available. Installing a Bundle or composing a preset row does not start a product, authenticate an account, select a model, probe credentials, or manage native product settings.
