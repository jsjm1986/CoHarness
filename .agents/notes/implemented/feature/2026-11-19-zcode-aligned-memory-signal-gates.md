# Agent Note: ZCode-aligned memory recall/extraction gates and auxiliary posture

Status: implemented

English | [中文](2026-11-19-zcode-aligned-memory-signal-gates.zh.md)

## Problem

A second source-verified audit of ZCode's memory subsystem (`memory/extraction.ts`, `memory/dream.ts`, `memory/recall/*`) found four gating and posture details the DSH port had skipped:

- Recall fired the selector on any non-empty human text; ZCode requires at least two word units (`/\s/` on the trimmed query), so one-word acknowledgements never trigger a model call.
- Recall candidates were deduplicated only against injected `memory-recall` keys; ZCode also excludes memories the agent already read in full this session (`findLatestReadFileState`).
- Extraction qualified any turn with a human `user/message`; ZCode requires at least three words of user prose (`MINIMUM_USER_WORDS`).
- Auxiliary requests rode the conversation's full model options; ZCode pins every auxiliary call to the model's lowest reasoning tier plus a 5,000-token output cap (`auxiliaryModelOptions`), and recall content carries a staleness caution on entries older than a day.

## Decision

Port all four, adapted to the typed memory service:

- `memorySignalWordCount` in `dsh-memory` is the shared word proxy: whitespace-separated tokens plus one unit per Han ideograph. ZCode's Latin-only `split(/\s+/)` would count a whole Chinese sentence as one word; the per-character rule preserves the same admission bar for CJK prose.
- `memory-context` skips the selector under two signal words and folds `memory_read` `tool/call` events into a `read` set — an entry the agent already fetched needs no summary re-injection. The fold keys by name, conservatively excluding same-named entries in other scopes.
- `memory-curation` sets `sawHuman` only on a message of at least three signal words.
- Every auxiliary request — the recall selector and both curation loops — resolves the model's lowest advertised reasoning effort via `llm.resolveModelInfo` and caps output at `AUXILIARY_MAX_TOKENS` (5,000). A failed metadata lookup only drops the effort hint.
- `renderRecallEntry` prefixes entries updated more than a day ago with the same "N days old" point-in-time caution ZCode's content renderer emits.

## Alternatives considered

Keep the harness-local thresholds — any human turn qualifies extraction, any non-empty recall query reaches the selector, auxiliary calls inherit full model options. Rejected: ZCode's gates were tuned against production traffic and dropping them buys nothing but simpler code at a real recall/extraction cost. A CJK tokenizer for the word proxy was also rejected: per-ideograph counting preserves the same admission bar without a dependency.

## Consequences

Single-word turns and acknowledgements no longer spend selector calls. An agent that already read a memory does not get its summary re-injected. Auxiliary calls cost the cheapest tier the route advertises. ZCode's remaining unported behaviors — a sticky selector conversation and dream-time transcript harvesting — stay deliberately absent: durable key folding already prevents re-selection across compaction, and per-turn extraction already harvests new signal, so consolidation only needs to merge.

## Testing

Seven new specs cover the word bar (Latin, CJK, mixed, empty), the already-read exclusion including malformed and non-string call arguments, the effort/maxTokens request fields, the staleness note under fake timers, and the extraction prose threshold. All `packages/memory/` suites pass at 100% per-file coverage.
