# Agent Note: Retain migration verification admission through queue waits

Status: implemented

English | [中文](2026-10-31-migration-verification-resource-owner.zh.md)

## Problem

Historical Session publication waits for both provider-local verification capacity and node process admission. Looking up the resource provider only after the first queue, or accepting a grant after that provider has changed, can start a verification thread under a different resource owner.

## Decision

The verifier captures its resource provider before either wait and checks that provider after each wait, immediately before creating the Worker. Cordis tracing proxies compare by their original Service identity. A changed provider, including transitions to or from independent admission, rejects with `ResourceAdmissionError` reason `unavailable`. Any unused grant returns to its original owner. Existing verification and termination retain their accounting obligations.

## Alternatives considered

**Adopt the current provider after waiting.** This transfers an accepted request to an owner that did not receive it.

**Use the original grant after replacement.** A grant from a withdrawn owner does not authorize new work in the current composition.

**Cancel an already running verifier on every provider change.** Pending allocation needs current authority; a running verifier still needs orderly termination and completion through its original owner.

## Consequences

A failed write open preserves committed historical generations and publishes no successor. A fresh write open can retry after admission recovers. Session formats, migration stages, configuration and successful SDK transcripts remain unchanged. The [preparation decision](../architecture/2026-09-05-read-only-session-migration-preparation.md) continues to own read preparation and immutable publication.

## Verification

Unit cases cover both queues, withdrawal, replacement, independent-to-managed transitions and real Cordis Service proxies. A [Loader example](../../../../packages/session/session-persistence-jsonl/tests/fixtures/migration-owner.mjs) performs historical write opens with real Worker Threads, checks unchanged source bytes and failed publication, then retries successfully. Its keyless snapshot includes unchanged managed and independent admission.
