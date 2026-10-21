# Agent Note: Session-title provider strategy split

Status: implemented

English | [中文](2026-10-18-session-title-provider-strategy.zh.md)

## Problem

Model-backed session titles shipped as a shared helper in `dsh-session-title-llm`: `registerSessionTitleLlmProvider` registered a provider for the caller, and `generateSessionTitleWithLlm` owned the prompt, JSON framing, output parsing, and title-length targets for every provider through one `SessionTitleLlmMessageSelector`. That worked while both shipped providers wanted identical wording and parsing, but it made strategy details — how the all-prompts cadence should anchor the current title for stability, which reasoning effort a title call should use, how much output interpretation belongs to the model contract — impossible to vary without touching the shared package. The title-length targets were also the only provider-specific fields inside shared execution config, which made `SessionTitleLlmConfig` describe two different ownerships.

## Decision

The seam is redrawn between *strategy* and *execution*. `@deepseek-ai/dsh-session-title-llm` is now an execution module: `SessionTitleLlmConfig` carries only `maxInputBytes`, `maxOutputTokens`, `timeoutMs`, and the optional paired `provider`/`model` route. Each provider plugin registers itself directly with `ctx.sessionTitle.register({ id, automatic, generate })` and inside `generate(request)` owns its system instruction, user input, source `messageSeqs`, title-length targets, output parsing, and reasoning selection, calling `executeSessionTitleLlm(ctx, config, request, titleProvider, { system, input, messageSeqs, selectReasoningEffort })`.

The executor owns what must not drift: route resolution through the logged `request/header` when no override pair is configured, the `maxInputBytes` measurement of the provider's finished input, the `maxOutputTokens` cap, fused timeout/caller cancellation rechecked during and after the stream, the exact log-only `session/title-llm-request` record appended before dispatch, `ctx.llm.prepareCall` dispatch with `purpose: 'session-title'`, and stream assembly into content blocks plus the terminal finish. It returns `{ blocks, finish, model }` and does not judge the output: each provider rejects `tool-calls` and `max-tokens` finishes, assembled tool-call blocks, and empty titles on its own terms.

Reasoning effort is provider-selected. `selectReasoningEffort` inspects the resolved `LlmResolvedModelInfo`; the shipped providers return the route's least supported effort (`model.reasoning?.efforts[0]?.id`), leaving effort unspecified when the route exposes none. Because this fork's `ctx.llm.prepareCall` takes `(config, signal)` without a metadata callback, the executor resolves the model info itself, applies the selected effort to the call config, and reads the effective effort back from `call.config.reasoningEffort` into the request record. `session/title-llm-request.reasoningEffort` is optional, so records written before the field existed remain readable.

`SessionTitleProviderRequest` gains `currentTitle`, a deep-frozen snapshot of the latest accepted title — fallback and user titles included — captured from the full event snapshot immediately before each provider call while `messages` stay bounded to the scheduled revision watermark. The all-prompts provider anchors a provider-sourced `currentTitle` in a `{ currentTitle, messages }` JSON object with preserve-if-adequate instructions, so an adequate title survives regeneration verbatim; fallback and user titles are never anchored, and the first-prompt provider ignores the field.

## Alternatives considered

- **Keep the shared registration helper and grow its options** — rejected: a shared prompt/parse policy is exactly the coupling being removed; each new strategy knob (anchor rules, effort selection, acceptance) would have widened one config surface that no provider fully owns.
- **Keep one provider plugin with a `SessionTitleLlmMessageSelector` option** — rejected: message selection was never the real variance point; cadence, framing, anchoring, and parsing all differ, and a selector type cannot express them.
- **Make `reasoningEffort` required on new request records** — rejected: released logs carry records without the field, and required-on-read would break readers of committed generations. Optional keeps the field additive.
- **Have the executor pick the effort** — rejected: whether a title call should reason cheap is a model-contract decision owned by the provider's strategy, symmetric with its prompt.

## Consequences

- The two shipped providers deliberately duplicate small framing idioms — `jscpd:ignore` markers document where the shared code ends and per-provider policy begins.
- `SessionTitleLlmConfig` shrinks to pure execution controls; `targetWords`/`targetCjkCharacters` move into each provider's `Config`, so a provider can vary or drop targets without a shared schema change.
- Old `session/title-llm-request` records stay readable; new records additionally pin the effective reasoning effort, so snapshot goldens generated after the change carry `reasoningEffort` where earlier generations do not.
- The old helper names (`registerSessionTitleLlmProvider`, `generateSessionTitleWithLlm`, `SessionTitleLlmMessageSelector`) no longer exist; pre-stable consumers move together under the repo's update-every-consumer rule.
- This partially supersedes the provider-half of [log-backed session titles](../feature/2026-07-21-log-backed-session-titles.md), which remains the decision for event ownership, fallback, registration lifecycle, and folding.

## Testing

- `pnpm vitest run packages/session` — 2716 tests across 106 files pass; `session-title-all-prompts-llm/tests/provider.spec.ts` pins anchor selection, seeded history, least-effort selection, first-line parsing, finish/tool rejection, and verbatim-title preservation, and `session-title-first-prompt-llm` covers the same execution paths under the first-prompt cadence.
