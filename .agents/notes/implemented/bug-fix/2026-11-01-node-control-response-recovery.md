# Agent Note: Node control-response recovery

Status: implemented

English | [中文](2026-11-01-node-control-response-recovery.zh.md)

## Problem

Node enrollment, connection acquisition and heartbeat can commit before their response body reaches the agent. Treating an interrupted body or an oversized capacity-refusal page as an invalid successful response terminates the process unnecessarily. A replacement process acquires a different connection and can fence Runtime generations that belong to the previous connection.

## Decision

The node agent classifies HTTP refusals by status before interpreting their bounded error body: 429 and 5xx permit retry; other refusals remain terminal unless their declared protocol code provides an existing recovery path. The body can refine a refusal code, but failure to read it cannot turn a known refusal into successful-response validation.

On successful HTTP responses, a body-read transport failure permits retry with the same candidate credential, process connection UUID and known epoch. Malformed JSON, missing lease fields, oversized successful bodies and identity mismatches remain terminal. Request and retry deadlines retain their existing configuration. The agent never derives execution authority from a missing acknowledgement; the center's current credential and lease remain authoritative.

## Alternatives considered

**Restart after every body-read failure.** Restarting replaces the process connection UUID even when the center committed the original operation, causing avoidable lease and Runtime turnover.

**Retry every invalid response.** Retrying malformed successful replies or mismatched identities hides protocol and deployment errors. Successful replies retain their existing schema, identity and byte-limit checks.

**Increase the response limit.** A larger limit does not repair interrupted streams and spends more memory on an error page. Error bodies remain bounded and HTTP status determines their retry class.

## Consequences

Transient reply failures do not by themselves replace the lease owner. Prolonged failures can still expire the lease, and the existing lease-lost recovery can advance its epoch. Credential revocation, detachment, shutdown cleanup and Runtime fencing retain their existing rules.

Diagnostics expose declared failure codes, not raw response bodies or credentials. The protocol, private state-file format, configuration and database schema are unchanged. [Shared node-channel authorization](2026-10-31-node-channel-shared-authorization.md) independently governs database locking during admission.

## Verification

Real HTTP fixtures interrupt bodies after the native fetch receives their headers, exercise oversized 429 and 503 replies, and check credential and connection reuse. They also retain terminal 401/403 refusals, malformed successful replies and both declared and streamed response-size limits. Independent-process verification uses a real authenticated Gateway and PostgreSQL; loopback tests do not establish public-network reliability.
