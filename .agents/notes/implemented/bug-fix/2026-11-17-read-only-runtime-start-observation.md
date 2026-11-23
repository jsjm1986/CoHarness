# Agent Note: Read-only observation after a lost Runtime start response

Status: implemented

English | [中文](2026-11-17-read-only-runtime-start-observation.zh.md)

## Problem

A remote start can be accepted while its HTTP response is lost. Treating that outcome as a confirmed failure invites a duplicate start; refreshing a POST page can replay it. A scope cookie cannot identify which computer the original tab addressed.

## Decision

The account form enters a read-only continuation when a submitted forward loses its response headers. The Gateway signs the authenticated account, resolved computer, Runtime, space and fixed deadline with a process-owned key. It pins those selectors before forwarding. Each continuation GET resolves current placement and topology without starting a process; ready state redirects to that exact target. The queue and readiness configuration bounds additional observation. Expiry, Gateway restart, stopped state, changed placement or revoked permission ends polling without stopping accepted work or choosing another computer.

Admin lifecycle controls capture the displayed owner, computer, allocation and generation before sending a start. The center already authorizes an exact catalog read for administrators. After a transport failure, the page uses that read until the expected generation becomes ready on an active computer. A cold start expects the successor generation. A start for an already starting or ready process expects the displayed generation. A different allocation or generation ends observation. A missing selection or expired observation leaves the outcome unknown.

This extends the exact-target rules in [browser Runtime identity](../architecture/2026-10-29-browser-runtime-and-document-location.md); their document, Session and configuration ownership decisions remain independent.

## Alternatives considered

**Repeat the POST.** A repeat cannot distinguish a lost response from an unaccepted request and can duplicate accepted work.

**Increase the proxy timeout.** A larger timeout merely delays the same uncertain outcome.

**Keep server tickets.** An unbounded ticket map retains per-click state; process-local signatures preserve the original selection without that retention or persisted browser state.

## Consequences

The continuation is not execution authority. It grants no rights, changes no scope cookie and cannot revive a stopped Runtime. Connection-acquisition failures, cancellation and explicit remote refusals retain their existing failure handling.

## Verification

The runnable Gateway transcript loses a submitted response while a real local Runtime start is held, then observes authenticated readiness without another start. Route tests cover personal and project targets, changed placement, current denial and expiry. Two observing tabs retain their original selectors.
