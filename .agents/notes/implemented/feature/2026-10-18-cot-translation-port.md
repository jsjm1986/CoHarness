# Agent Note: Chain-of-thought translation port through fork seams

Status: implemented

English | [中文](2026-10-18-cot-translation-port.zh.md)

## Problem

Upstream rc.2 ships machine translation for expanded reasoning: the `translator` service (anonymous translation endpoints plus optional native Flash, with reusable Session results), `client-ui-cot-translation` (translate expanded thinking while retaining the original text and saved results), and the `cot-translation-bundle` opt-in patch (`provider: bing`, `targetLanguage: auto`). The fork had deferred the group because it "requires the excluded deepseek-account provider surface"; the plugin-manager showcase lists the bundle, so the row needed real content.

## Decision

All three packages are ported into `packages/experimental/` under upstream names with upstream bilingual `locale/*.json` and `icon.svg` verbatim. The account-surface blocker did not hold: the translator's default provider path is anonymous HTTP endpoints (`provider: bing` in the bundle patch), so the feature runs without the excluded account chain — that chain is only one optional provider among several.

`client-ui-cot-translation` mounts on the fork's own conversation surface (`dsh-client-ui-conversation` imports in its client half) instead of upstream's `ui-chat`. `cot-translation-bundle` is registered in `OPTIONAL_BUNDLES` for the showcase toggle and in `apps/cli` dependencies; none enters a shipped default composition.

## Alternatives considered

- **Keeping the defer** was rejected: the blocker was one optional provider surface, not a hard dependency; the bundle's own default uses an anonymous provider.
- **Rewiring translation to fork's `llm` seam** was rejected for this port: upstream's provider contract already abstracts endpoints, and routing reasoning text through the model service would conflate translation with generation.

## Testing

Per-package specs ported with the sources (`translator` 13 spec files, `client-ui-cot-translation` 7, `cot-translation-bundle` patch spec); `tsc --noEmit` clean. Registration completed directly after the original porting agent was interrupted.

## Consequences

Reasoning translation runs over anonymous endpoints by default, so the feature ships with no account dependency; the optional Flash provider remains available for deployments that configure it. The bundle is opt-in — shipped default compositions are unchanged until a profile enables it.
