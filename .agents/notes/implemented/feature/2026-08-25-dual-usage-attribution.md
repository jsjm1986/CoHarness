# Agent Note: Separate billing ownership from project activity attribution

Status: implemented

English | [中文](2026-08-25-dual-usage-attribution.zh.md)

## Problem

Shared project model calls are billed to the project runtime, while the administrator user table is keyed by personal runtime ownership. A project member can therefore perform model work and still appear to have zero personal usage. Copying the project total onto every member would make organization totals and costs incorrect.

## Decision

Usage keeps exactly one billing subject: `user_id` for personal runtimes or `project_id` for shared runtimes. New records may also carry a verified `actor_user_id` extracted from authenticated participant metadata in the model request; the participant's project id is checked against the project intake subject before the actor is stored. Actor data is used only for contributor activity reports and never for quotas or billing totals. Requests without a reliable participant remain unattributed.

Existing project records are not backfilled. They remain project-owned historical records and are shown separately from confirmed contributor activity. If a new actor claim cannot be verified at intake, the runtime retries the same billing event without actor fields, preserving project totals while leaving the activity unattributed. Price coverage is recorded independently so a missing price is not presented as a free call.

## Alternatives considered

**Assign every project call to the conversation creator.** Rejected because collaborators can contribute to a creator-owned conversation and the creator is not necessarily the caller.

**Join project usage to every project member.** Rejected because it duplicates every call and inflates tokens, costs, and quota measurements.

**Infer all historical actors from the latest participant message.** Rejected because forks, background work, retries, and old logs do not provide a reliable one-to-one request actor.

## Consequences

The administrator UI must label personal, project, and contributor totals separately and must not add contributor rows to billing totals. Historical unattributed usage remains visible instead of being silently assigned. The usage wire and PostgreSQL schema carry an additional nullable actor and pricing status, so old runtimes can continue reporting billing usage without contributor attribution.
