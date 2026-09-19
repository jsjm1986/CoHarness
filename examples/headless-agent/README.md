# headless-agent

English | [中文](README.zh.md)

This directory owns the replay and real-model test composition for a headless coding agent: DeepSeek V4 + local bash and filesystem tools + subagent delegation + workflows and fresh-agent Ralph iteration + `todo_write` + JSONL persistence. It explicitly mounts the shared agent spine, one root agent, persistence, and checkpoint policy; it is not a second product entry point.

## Run it

```sh
# repo root .env (gitignored) or exported env:
#   DEEPSEEK_API_KEY=sk-…
#   DEEPSEEK_BASE_URL=https://…   # optional; defaults to the public API
pnpm dsh --profile headless "fix the failing test in this workspace"
```

The product command is [`dsh --profile headless`](../../apps/cli/README.md): it accepts one nonblank task, creates and persists a fresh session, prints the final assistant text, and exits.

Snapshot suites run this directory's configuration through [`tests/fixtures/headless-driver.ts`](tests/fixtures/headless-driver.ts), an unexported test-only process that emits canonical session events as JSONL before its result record. That stream is test infrastructure, not a supported CLI output format. Child sessions surface only through parent tool events and results.

## Advanced configuration

[`advanced.cordis.yml`](advanced.cordis.yml) adds PTC and the Cordis tools to the test composition.
