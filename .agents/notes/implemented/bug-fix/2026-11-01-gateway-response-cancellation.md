# Agent Note: Bounded response failures do not wait for cancellation acknowledgement

Status: implemented

English | [中文](2026-11-01-gateway-response-cancellation.zh.md)

## Problem

A response body can acknowledge cancellation only after another branch or its underlying cleanup finishes. Waiting for that acknowledgement after a byte-limit failure prevents a bounded read from rejecting, even when its caller subsequently cancels. The same wait can occur when cancellation lands between chunks. A response supplied to an already-cancelled read also needs its body cancelled.

## Decision

Gateway response readers request body cancellation and return the original size or cancellation failure without awaiting cleanup acknowledgement. They observe cancellation rejection separately so it cannot become an unhandled rejection or replace the primary read failure. Reader locks are released when the read ends, including while underlying cleanup remains pending.

Archive synchronization cancels unused snapshot, acknowledgement and probe refusal bodies before reporting their HTTP status. It reports the refusal independently of cancellation acknowledgement, while successful responses retain bounded JSON reading. Synchronization retry and command ownership rules remain unchanged.

## Alternatives considered

**Wait for cancellation to prove cleanup.** A shared response branch may belong to another consumer and cannot set this read’s completion time.

**Rely only on the fetch signal.** The exported reader accepts an existing response and its own cancellation signal. Its caller’s cancellation need not be the signal that created the transport.

## Consequences

Read failure proves that no further response bytes enter the caller, not that physical transport cleanup has finished. The transport owner retains that responsibility. Resource occupation still follows [confirmed execution cleanup](2026-11-01-uncertain-resource-cancellation.md), independently of the response reader’s result. Wire messages, configuration, Session data and schema versions stay unchanged.

## Verification

Controlled response streams keep cancellation acknowledgement pending while declared overflow, streamed overflow and cancellation between chunks reject. Pre-aborted reads cancel their bodies; cleanup rejection preserves the primary failure. Runnable SDK scenarios read an oversized branch of a real open HTTP response, preserve the size error before closing the other branch, and then await physical server-response closure. Complete original source and built Runtime packages fail the new scenario while retaining the earlier resource scenarios.

An unfinished native HTTP refusal closes while the archive provider stays loaded, and a later durable archive synchronizes through both SDKs. Snapshot, acknowledgement and probe cleanup rejection preserves the HTTP status. Original archive providers retain the unfinished response until disposal.
