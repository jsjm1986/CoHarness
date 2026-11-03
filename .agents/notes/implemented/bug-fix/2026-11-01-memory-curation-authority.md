# Agent Note: Curation retains its issuer through dispatch and cursor admission

Status: implemented

English | [中文](2026-11-01-memory-curation-authority.zh.md)

## Problem

Project curation can wait for catalog reads, model capacity, responses, tools or the serialized cursor queue. An initial memory qualification check cannot authorize later dispatch or completion progress. Generic model execution permission remains possible after memory qualification is withdrawn. A replacement execution service must not lend its permission or actor to work captured under another issuer.

## Decision

Each pass retains the captured execution service and participants. Availability checks compare the current service's original Cordis identity with that issuer after asynchronous work. Project qualification is rechecked before each model round, after its response and inside the cursor write queue immediately before persistence. The cursor service invokes an optional `beforeCommit` callback after queue and storage waits, then checks cancellation and invokes the returned synchronous guard immediately before persistence; callbacks cannot enqueue writes on that same chain.

The plugin owns an `AsyncLocalStorage` instance carrying the captured turn through its existing `runCaptured` lifetime. Its `llm/pre-dispatch` listener rechecks that operation after capacity admission and before adapter-owned physical requests. Unrelated requests have no curation context. No Session-id registry or current browser identity substitutes for the captured participants. Rechecks use the original issuer, compare it again after authorization and never transfer work to its replacement.

These permission checks acquire no model permits and report no usage. The request retains its original billing witnesses, exact logged input and execution resource origin. An already dispatched request retains its provider cleanup owner; refusal prevents its result from opening another round or committing completion progress. Admitted durable entry writes keep their existing outcome. Settings cancellation remains governed by [independent operation lifetimes](2026-10-31-memory-curation-live-availability.md) and [provider availability notification](2026-11-01-memory-provider-availability.md).

## Alternatives considered

**Use generic execution permission.** Project memory additionally requires memory qualification and the eligible conversation visibility; execution permission alone does not establish either.

**Check only before calling the model service or enqueueing a cursor.** Capacity and serialized storage waits can outlive that check. The actual dispatch and commit admission must recheck current authority.

**Look up the current issuer or Session actor for every round.** A replacement can attest a different actor. The operation retains its captured issuer and refuses replacement instead of transferring identity.

**Authorize every request sharing a Session id.** Recall, primary requests and several captured turns can overlap. The operation's asynchronous context identifies its own dispatch without changing independent requests.

## Consequences

Revoked project qualification or issuer replacement leaves unfinished reviews eligible for a later authorized pass. Shared entries remain readable through their existing member permissions. No model grant, quota, billing format or Session/storage schema changes. The optional callback extends the internal cursor API; every in-repository consumer retains cancellation and commit ordering. Broader Gateway membership, physical-computer and production acceptance remain separate review work.

## Verification

Real LLM tests hold catalog reads, capacity grants, model responses, adapter preparation and cursor queues across qualification withdrawal or issuer replacement. They assert actual dispatch, permit release and durable cursor outcomes after task completion. An authorization result arriving from a replaced issuer is refused. Shipped SDK processes exercise extraction and consolidation through real model admission and tool rounds, retaining the original actor and exact logged request. Complete private predecessor packages reproduce stale dispatch, extra model admission or cursor advancement without editing the active source. Existing normal curation and auxiliary-request snapshots remain regression coverage.
