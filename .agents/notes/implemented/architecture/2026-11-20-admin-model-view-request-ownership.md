# Agent Note: Admin model views own their readiness and reads

Status: implemented

English | [中文](2026-11-20-admin-model-view-request-ownership.zh.md)

## Problem

A slow account directory request delayed preparation of both model detail tabs after the organization catalog had rendered. Overlapping personal registration requests could display an earlier report under the latest filter.

## Decision

The organization catalog schedules the shared detail chunk after its own readiness and paint. The selected detail tab starts the shared account choices. The report query owns a cancellation signal and commits results and feedback only for the current request. Applying different filters clears the previous report.

## Alternatives considered

**Use one readiness condition for the whole page.** The catalog, pricing and registration history have independent dependencies and become usable at different times.

**Cancel the previous HTTP request alone.** A response or error already queued for delivery may still race with the new filter. The cancellation signal also guards every state update.

## Consequences

The first visit to a detail tab can load account choices alongside its own content. The tab can show its content while account choices arrive, and the catalog can prepare the module while the pricing model read is pending.
