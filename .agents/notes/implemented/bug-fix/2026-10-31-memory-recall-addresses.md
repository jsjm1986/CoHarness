# Agent Note: Recall addresses describe admitted content

Status: implemented

English | [中文](2026-10-31-memory-recall-addresses.zh.md)

## Problem

Recall selection and message fitting have different outcomes: a selected entry can exceed the remaining frame budget. Recording every selection as an injected address makes an omitted entry disappear from future candidates, including after compaction. Bare selector keys also require deterministic resolution when multiple offered scopes contain the same name.

## Decision

The frame fitter returns the text and addresses of the same retained prefix. Only those addresses enter the durable `memory-recall` source. A selected entry omitted by the frame budget remains eligible on later turns. Repeated selector keys contribute an address once, and a same-named key resolves to the first eligible row in the catalog's scope order.

UTF-8 input and content bounds retain complete characters. An incomplete final encoded character is omitted without flushing a replacement character that can exceed the byte budget. The complete rendered reminder, including framing and staleness text, remains subject to the message and visible-session budgets.

The [auxiliary request decision](2026-10-24-memory-auxiliary-ownership.md) still owns exact request logging, admission attribution, cancellation and cleanup. The [signal-gate decision](../feature/2026-11-19-zcode-aligned-memory-signal-gates.md) retains its independent human-input and already-read exclusions. Neither is superseded by fitting the final injected content.

## Alternatives considered

**Deduplicate every model selection.** A selection can be omitted before reaching a model request. Deduplication must describe published content.

**Recover addresses by parsing rendered entry bodies.** Entry content is free-form text and can contain the same delimiters as the reminder. Durable metadata provides an unambiguous producer-owned record.

## Consequences

Compaction can reclaim recall bytes without making an already recorded address eligible again. Historical address metadata remains authoritative as recorded; this change does not rewrite committed Session generations or infer corrections from their text. Starting a new Session resets historical deduplication. Selector output stays the existing key-only JSON format and Session events retain their existing fields.

## Verification

Focused cases cover partial frames followed by another turn, repeated selections, same-named personal and workspace entries, and three- and four-byte character cuts. A real Loader, Agent, JSON domain and model-admission provider exercise three turns and compare the complete durable recall text and addresses while confirming every model admission is released. Controlled private variants restore incorrect provenance or last-scope resolution without modifying shared production files.
