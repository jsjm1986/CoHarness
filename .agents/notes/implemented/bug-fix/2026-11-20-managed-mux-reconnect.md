# Agent Note: Resume a managed conversation before Host metadata

Status: implemented

English | [中文](2026-11-20-managed-mux-reconnect.zh.md)

## Problem

On the production Ubuntu link, a browser received the first reply data 22.54 seconds after submission and painted it at 34.80 seconds. The conversation stream had opened at 16.85 seconds. The Host status stream opened at 25.59 seconds, after which the browser read history through the general path for 9.14 seconds.

On a later forced reconnect, the Host sent the only missing title just before the baseline that counted it. The early resume path waited for the baseline and fetched the same event through a prepared history read that took 2.57 seconds.

## Decision

On a browser reconnect, fresh Host description and an open Mux can resume an existing root conversation whose account, Runtime, computer and sequence baseline match. The previous generation establishes its exact target when `host.describe` and Mux qualify, even if it loses the connection while the Host status stream is still opening. Only the conversation's baseline, durable events and assistant stream enter this early path. Other frames stay on the full handshake. The Mux generation aborts its outstanding tail reads. A covered watermark requires no history call. A gap uses the existing exact-target history preparation and preserves the [bounded live window](2026-09-03-bounded-live-window-and-incremental-reconnect.md).

The [Host mux](../../../../packages/host/apiproxy/README.md) keeps its full durable cursor and sends a retained tail title after the baseline. A tab that already has the title can accept the opening. A tab that missed only the title applies it as the next durable event and shows the reply while the history request runs.

## Alternatives considered

**Wait for both streams before reading history.** Even a faster tail reader leaves the reply waiting for the Host status connection. The two streams share a full readiness state, and only an existing verified conversation can resume early.

**Show arbitrary live chunks across a missing durable prefix.** Turn and settlement folding require contiguous events. The missing prefix must arrive before the resumed reply can join the existing conversation.

## Consequences

The open conversation can show a continued reply while the Host status stream is still opening. The outstanding submission and its tab-local draft retain their original ownership. The browser fixture holds the Host upgrade and history response. Both a received and a replayed tail title allow the reply to appear before history completes. A missing predecessor requires one prepared read before the reply appears. Each case renders the reply once.
