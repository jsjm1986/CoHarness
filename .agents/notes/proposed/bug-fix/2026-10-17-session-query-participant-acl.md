# Agent Note: Participant-readable ACL for session-query tools

Status: proposed

English | [中文](2026-10-17-session-query-participant-acl.zh.md)

## Problem

`dsh-tool-session-query` authorizes every cross-session target by working-directory equality: a session may search, trace, and read any session whose `cwd` matches the caller's. In a Gateway project runtime every member's sessions share the project directory, so `cwd` equality spans the entire project — one member's agent could read every other member's sessions, including conversations the project ACL marks `private`. Working-directory equality answers "same filesystem context", not "this participant may read this session"; in shared project runtimes this is an information-disclosure bug, not a missing feature.

## Proposal

When a `collaboration` service is composed, each cross-session id must additionally appear in `collaboration.capture().readableSessionIds(ids)` — the same participant-scoped readable-set filter `session-reference` already applies in agent context. A `personal` participant scope returns the input set unchanged, so no scope special-casing is needed, and compositions without the service keep `cwd`-only behavior.

Each operation batches one `readableSessionIds` call per authorization stage and threads the returned `ReadonlySet<SessionId>` into the synchronous filters:

- `authorizeTarget` requires the target to be readable in addition to `cwd`-equal; the caller's own session keeps its early return.
- `authorizeSessionIds` intersects the `cwd`-authorized set with the readable subset.
- `session_search` resolves the authorized workspace set once — one `cwd`-corpus enumeration plus one batched readability call — and reuses it for requested parent ids, streamed hits, hit parents, and title revalidation, because hits arrive over provider pages and cannot each await their own batch.
- `session_trace` batches the target, every ancestor, and the complete descendant tree into one readability call after the lineage read, then applies that set to the ancestor boundary, the descendant projection, and title checks.

When `capture()` throws — an ambient turn with no bound request principal — the operation fails closed: every cross-session id is unauthorized while the caller's own session stays reachable, keeping the existing `serviceBoundary.unauthorizedTarget()` denial. A readability provider failure propagates through the model-safe sanitizer like any other `ctx.sessionQuery` failure instead of silently downgrading authority.

## Alternatives considered

- **Keep `cwd` equality as the sole check.** It carries no visibility information and cannot distinguish a private conversation from a shared one inside a project directory.
- **Authorize per record inside the synchronous filters.** `readableSessionIds` is async while lineage and search-hit filters are synchronous, and per-record calls would multiply Gateway requests by result count.
- **Apply the readable set only at the search boundary.** The model could then reach the same sessions through `session_trace` or `session_event_read`; enforcement has to live in the shared authorization helpers every operation passes through.
- **Fail the whole operation when `capture()` finds no principal.** Ambient turns legitimately inspect their own session; denying everything would break standalone scheduled work, while failing closed preserves the self path.

## Acceptance criteria

- A project member's agent cannot search, trace, or read a same-`cwd` session the participant ACL marks unreadable; the denial keeps the `SESSION_QUERY_TOOL_UNAUTHORIZED` shape with no id leak.
- The caller's own session stays reachable in every composition, including ambient turns.
- `session_search` issues one batched readability call covering requested parents, hits, hit parents, and titles; `session_trace` issues one covering the whole returned lineage.
- Compositions without `collaboration` behave exactly as before; unit tests cover denied targets, filtered sets, lineage redaction, ambient fail-closed, and provider-failure sanitization.

## Risks

The workspace enumeration adds one corpus listing to `session_search` under collaboration, and a readability revocation between enumeration and the later provider read is still caught by the observation revalidation each operation already performs. Personal-scope and standalone compositions keep the `cwd` rule, so the tightened rule applies only where a participant ACL exists.
