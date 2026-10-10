# @deepseek-ai/dsh-steward-tools

English | [中文](README.zh.md)

Tool surface for the reserved **steward** maintenance runtime: one audited SQL channel into the deployment's PostgreSQL database. The Gateway mounts this package only on the steward project's runtime (`HGW_STEWARD_TOOLS_PACKAGE`); every other runtime profile never sees it.

## What it does

- Registers `steward_query`: runs one SQL statement through `POST /internal/runtime/steward/query` on the runtime's own loopback credential (no token material enters the tool surface).
- Read statements (`SELECT`/`WITH`/`VALUES`/`TABLE`/`SHOW`/`EXPLAIN`) execute directly. Anything else first asks the operator through the session approval channel, then carries the granted approval id to the Gateway, which re-verifies it against `conversation_interaction_responses` before executing.
- `dry_run` returns the statement's `EXPLAIN` plan without executing — including for writes, which need no approval because nothing is applied.
- Every attempt — read, denied, failed, applied — is journaled by the Gateway in `harness.steward_query_log`.
- Registers the `steward:policy` system-prompt section so the model knows it runs in the maintenance channel: audited SQL, read-only transactions, in-conversation write approval, journaling.

## Boundary (honest limits)

- Statement classification in this package is a UX hint for the approval prompt. The authoritative classification and limits (statement bytes, row cap, result bytes, statement timeout) live in the Gateway executor (`gateway/src/postgres/steward-query.ts`), which reclassifies independently — a mismatch denies, never widens.
- The tool cannot create approvals: without a granted in-session approval the write fails closed, and the approval id is bound to the calling session via its `callId`.
- The steward runtime cannot change its own plugin composition; `steward_query` is mounted by the deployment patch, not through plugin management.
- Administrative operations outside SQL (release activation, runtime restarts) are not exposed by this package; the operator applies them from the admin surface.

## Tests

`tests/query.spec.ts` covers statement classification and the approval-prompt preview; `tests/composition.spec.ts` covers the registered section, tool, and their disposal. The executor contract is covered by Gateway tests beside `steward-query.ts`.
