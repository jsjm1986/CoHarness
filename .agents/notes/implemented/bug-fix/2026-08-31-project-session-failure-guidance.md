# Agent Note: Project session failures use safe user guidance

Status: implemented

English | [中文](2026-08-31-project-session-failure-guidance.zh.md)

## Problem

Organization administrators have implicit read/write authority over every active project without a `project_members` row. The PostgreSQL conversation writer checked only explicit project membership, so an administrator's message could fail after the rest of the runtime had accepted it. An unexpected Gateway exception then returned plain text to a JSON-only persistence consumer, exposing parser details as the turn failure shown in Chat.

## Decision

`ConversationRepository` resolves a project writer from either an active `rw` project membership or an active organization administrator membership. The same rule applies when materializing a root and when recording a contributor; an administrator may contribute to a private project conversation under the documented administrator override, while a demoted administrator loses that authority on the next append.

Unexpected exceptions from runtime HTTP routes use a stable JSON error envelope and keep stack, SQL, and storage details in the Gateway log. `dsh-session-persistence-gateway` treats malformed or server-error bodies as safe dependency failures without retaining parser causes in the user-facing error chain. The conversation renderer maps persistence and authorization internals to localized retry guidance and suppresses the meaningless `UNKNOWN` code.

## Verification

PostgreSQL collaboration coverage exercises administrator root creation, project and private contributions, and rejection after administrator demotion. Gateway server coverage checks the runtime JSON error envelope. Persistence transport coverage checks plain-text 500 responses and parser-detail suppression. Client runtime and conversation tests pin safe persistence copy in Chinese and English.

## Alternatives considered

**Add an explicit project-membership row for every administrator.** Rejected because the product policy intentionally grants administrators implicit authority and role changes must take effect without maintaining duplicate project rows.

**Expose the Gateway exception or parser text in Chat.** Rejected because it leaks implementation details, does not tell the user what to do, and can expose paths or provider diagnostics.

**Fix only the renderer.** Rejected because masking the message would leave administrators unable to write and would preserve a protocol mismatch for future runtime failures.

## Consequences

Administrator project conversations follow the same authorization rule as the collaboration service, including private roots. Runtime failures remain diagnosable in server logs while the browser receives stable JSON and a concise localized retry instruction. A failed append remains transactional, so rejected batches do not create partial conversation events.
