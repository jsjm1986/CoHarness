# Agent Note: Session-history recall tools, CJK full-text search, and project-readable ACL

Status: implemented

English | [中文](2026-10-18-session-history-recall-tools.zh.md)

## Problem

`dsh-tool-session-query` shipped complete workspace-authorized search, trace, and event-read tools, but three gaps kept session-history recall off the model's reach: the `standard` agent preset never mounted the package, the SQLite FTS5 `unicode61` tokenizer emitted every Han run as one token so Chinese queries could not match at all, and workspace-`cwd` equality was the whole authorization rule — mounting the tools inside a shared project workspace would have let any member search every other member's same-`cwd` sessions.

## Decision

Mount `tool-session-query` in the `standard` preset; the `sessionQuery` service and its SQLite index stay in the host composition, so personal-workspace deployments gain recall with no new surface.

[sanitizeFtsText](../../../../packages/session-query/session-query-sqlite/src/query.ts) — the single normalizer shared by indexed documents and MATCH queries — now splits every Han-adjacent character pair with a reserved zero-width space (`U+200B`). `unicode61` treats the join as a separator, so each CJK character becomes its own token and ordinary phrase matching yields substring semantics at any length: `记忆` matches inside `记忆系统`, and mixed runs such as `试A版` split at both boundaries. The join is stripped back out while normalizing highlighted snippets, so presented text is unchanged. Non-Han runs keep token/phrase recall rather than arbitrary substring recall.

Authorization in `dsh-tool-session-query` layers project readability over workspace equality. A new `readableSet` helper calls `collaboration.capture().readableSessionIds()` only when the `collaboration` service is mounted, mirroring the session-reference convention; when absent (personal workspace) the `cwd` rule is the complete rule and nothing changes. `authorizeTarget` rejects unreadable targets, `authorizeSessionIds` intersects requested parent ids with the readable set, session-search pages filter hits through a per-page batch call, and trace projection prefetches one set for all ancestor and descendant records so unreadable nodes keep the existing no-id boundary/subtree markers. Post-read revalidation keeps checking that the observed record is the authorized target.

## Alternatives considered

**Han bigram indexing (ZCode's approach).** Expanding Han runs to bigrams answers two-character queries but not three-or-more-character substrings or mixed Han/Latin runs. Per-character splitting with phrase matching covers all lengths uniformly.

**The `trigram` tokenizer.** Requires queries of at least three characters, so `记忆` still cannot match; rejected before implementation by direct SQLite probing.

**ACL inside `session-query-sqlite`.** The service contract is the corpus, not the participant; authorization belongs in the operation that performs the read, which is the tool layer. The provider stays participant-agnostic.

## Verification

`session-query-sqlite` specs cover Chinese substrings of two to four characters, mixed `试A版` runs, lone Han characters, snippet restoration without join leakage, and non-match absence. `tool-session-query` specs cover ACL-masked search hits, unreadable-target denial on all four target tools, unreadable subtree masking that withholds title reads, and unreadable parent-id filtering. `pnpm vitest run packages/session-query/tool-session-query packages/session-query/session-query-sqlite` passes 181 tests with 100% coverage on changed sources; `verify-cordis-config` accepts the new preset row.
