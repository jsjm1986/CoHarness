# Agent Note: Uncertain accounting retains execution cancellation

Status: implemented

English | [中文](2026-11-01-uncertain-resource-cancellation.zh.md)

## Problem

An acknowledged uncertainty report can retire a provider’s local accounting entry while execution remains unconfirmed. Keeping cancellation only on that entry disconnects the admitted owner from a later caller stop, provider disposal or accounting failure. Remote occupation alone cannot stop its transport.

## Decision

Each admitted lease combines the provider lifetime, its caller and its operation signal. Provider disposal and fail-closed accounting abort the shared lifetime independently of retained entries. Acknowledging uncertainty does not abort work by itself or detach these cancellation links. Proven quiescence still reports through the original exact completion reference and captured private transport.

## Alternatives considered

**Keep every uncertain entry locally until quiescence.** The remote coordinator already retains uncertain occupation. Local metadata need not remain solely to preserve cancellation.

**Cancel work when uncertainty is reported.** Reporting unconfirmed cleanup and requesting cancellation are separate actions. A report must not invent an additional cancellation reason.

## Consequences

Operation accounting and cancellation have separate lifetimes. Retiring local metadata cannot release remote occupation or revoke a later exact completion. The [registration retirement decision](2026-11-01-resource-registration-retirement.md) continues to govern work that has not been submitted. Wire messages, configurations, Session records and schema versions stay unchanged.

## Verification

Real Gateway HTTP/PostgreSQL cases report uncertainty before provider disposal, caller cancellation and failed accounting acknowledgement. Each cancellation remains observable while occupancy stays uncertain until exact release. Runnable SDK scenarios hold a real HTTP response open, unload the provider, observe transport closure and report uncertainty followed by quiescence. Complete original providers retain the open execution signal and fail these scenarios.
