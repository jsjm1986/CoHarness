# Agent Note: Personal document discovery is an opt-in Agent Consumer

Status: implemented

English | [中文](2026-09-01-personal-document-agent-tools.zh.md)

## Problem

The personal document store already persists named files and the browser can manage them, but an Agent could not discover an unattached file from its own model-facing tool set. The prompt-context Consumer only handles document ids that a user has attached, while filesystem search is scoped to the coding workspace and cannot establish that a matching file belongs to the user's private document store.

Without a store-aware discovery path, a request such as “find my annual report and summarize it” either asked the user to upload a file that was already present or guessed an absolute path. Both choices made personal documents harder to use and risked exposing host-specific paths or crossing a project scope.

## Decision

`@deepseek-ai/dsh-tool-userdoc` is a model-facing Consumer of the existing `ctx.userDocs` Service Definition. It registers `userdoc_list` for bounded metadata discovery and `userdoc_read` for bounded, line-numbered UTF-8 reads. Storage, naming, filesystem containment, HTTP transport, and browser management remain owned by `dsh-userdoc`, `dsh-userdoc-local`, `dsh-host-userdoc-http`, and `dsh-client-ui-documents`; the Agent Consumer does not duplicate those responsibilities.

The Consumer is mounted as a plugin row in the shipped `standard`, `code`, and `cordis` Agent presets. It injects `tools`, `systemPrompt`, and `userDocs`, adds one stable instruction that tells the model to list before asking for an upload, and never places the complete inventory in the system prompt. The `code` preset therefore receives the same capability through its generated SDK and does not require an agent-loop change.

`userdoc_list` filters names and root-relative ids, supports directory and offset pagination, orders results deterministically, and omits every absolute host path. `userdoc_read` re-resolves the returned id through `stat` and `openRead`, enforces deployment byte and line limits, preserves UTF-8 boundaries, rejects malformed text with `USERDOC_NOT_TEXT`, and reports a continuation offset only when a byte cap ends between lines; a cap inside a line asks for a larger byte limit. Both outputs are bounded after formatting and document bytes are treated as untrusted data rather than instructions.

The Consumer requires an owning Agent and refuses a Gateway project runtime with `USERDOC_PERSONAL_SCOPE_UNAVAILABLE`. A project Agent must receive an explicitly authenticated document-source Provider before it can access a personal store; the current plugin does not infer permission from a shared runtime or copy a user's private path into a project.

## Model-facing behavior

The model sees two read-only schemas only while the preset row is mounted. It calls `userdoc_list` when a personal-document reference is not attached, chooses a unique returned `doc_id`, then calls `userdoc_read` before summarizing. A capped page or line-complete read window gives an explicit `offset` recovery instruction; a partial-line byte cap asks for a larger deployment limit, and an ambiguous match remains a user choice rather than an arbitrary file selection.

## Verification

`packages/attachment/tool-userdoc/tests/` covers plugin lifecycle, schemas, prompt guidance, scope refusal, validation, deterministic formatting, UTF-8 and cancellation behavior, and the read/list execution paths at 100% per-file coverage. `examples/headless-agent/tests/userdoc-agent.snapshot.ts` boots the assembled local store and Consumer, seeds personal files without a browser attachment, and replays a keyless list-then-read model transcript.

## Alternatives considered

**Inline the personal inventory in every system prompt.** Rejected because inventory size and file names would consume tokens, alter a reusable prompt prefix whenever a file changes, and disclose private metadata even when the user asks an unrelated question.

**Reuse `glob`/`grep` over the host filesystem.** Rejected because those tools search the coding workspace, expose deployment-specific paths, and cannot prove that a result belongs to the authenticated personal store.

**Add list/read methods to the Agent loop or storage Service.** Rejected because the loop should schedule capabilities through the existing tool registry, while the storage seam must stay format- and transport-neutral. A separate Consumer keeps each plugin's ownership explicit.

**Expose personal documents from project runtimes whenever `ctx.userDocs` happens to resolve.** Rejected because service presence is not authorization. Cross-scope access needs a Gateway Provider that captures the principal, scope, and audit policy explicitly.

## Consequences

The standard user flow is direct: an Agent can find and inspect a personal document by name without an upload round-trip, an absolute path, or prompt inventory injection. Read-only bounds keep a large workspace and a large file from producing an unbounded model result, while stable ids let the model continue a paged operation.

Saving, editing, deletion, versioning, content indexing, and format-specific readers remain separate Consumers. Their approval, event logging, and authorization rules can evolve without widening this read-only package or weakening the personal/project scope distinction. A future authenticated Provider can reuse the formatting and tool responsibilities once its scope contract is defined.
