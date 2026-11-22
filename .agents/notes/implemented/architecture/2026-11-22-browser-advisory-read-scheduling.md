# Agent Note: Reserve browser connections for conversation actions

Status: implemented

English | [中文](2026-11-22-browser-advisory-read-scheduling.zh.md)

## Problem

Opening a Runtime conversation can request model, skill, terminal and plugin directories together. In one public HTTP/1 trace, the send shared the connection pool with twelve pending calls. The browser waited 11.34 seconds to write the request on a reused connection. The bytes reached the primary Gateway 185 milliseconds later. Connection reuse and optimizing the Runtime handler leave that browser queue in place.

With those catalogs limited, one send still waited 4.14 seconds while a session list and then draft autosave held the reused connection. A follow-up keyless create waited 2.83 seconds for the connection serving a permission catalog. The same browser trace showed the initial workbench page, settings and history index occupying other connections.

The send also competes with automatic Host synchronization. In a separate HTTP/1 sample, the workbench page held the send's connection for 5.03 seconds while session activation, a plugin manifest, draft autosave and a session list were in flight.

## Decision

The [document's Connection](../../../../packages/client/connection/README.md) admits three concurrent background requests until response headers arrive on HTTP/1 or an unknown protocol. A maximum of two can be reads. Session activation and plugin manifest synchronization take precedence, followed by the session list, history index and initial combined workbench read, then auxiliary catalogs and settings. HTTP/2 and HTTP/3 keep their concurrent request paths. Explicit high-priority requests bypass admission. HTTP/1 prepared creation, prompt admission and prompt status use high Fetch priority.

The queue keeps no response bodies and makes no retry. Page disposal and caller cancellation remove pending work. Each request keeps its pinned account and Runtime for Gateway authorization. Draft reads and versioned mutations use direct admission with the original revisions and receipts.

## Alternatives considered

**Rely on connection reuse and faster Runtime handling.** The traced send used a reused connection after waiting in the browser. The Gateway and Runtime can process the send only after the request reaches them.

**Use Fetch priority alone for catalog reads.** Lower priority still hands the entire catalog burst to the browser. On HTTP/1, a send can wait for a connection already occupied by an in-flight catalog read.

## Consequences

Auxiliary catalogs can appear later on HTTP/1. Bounded admission protects the conversation from one tab's initial catalog burst. Browser connection pools may still be shared with other tabs. Measurements report protocol, browser queue time, connection setup and the interval from writing the request to Gateway ingress separately.
