# Agent Note: Literal conversation search before fuzzy alternatives

Status: implemented

English | [中文](2026-10-25-gateway-literal-conversation-search.zh.md)

## Problem

PostgreSQL trigram similarity compares the query with the whole indexed event. A short query contained in a long message can fall below its threshold, and the database character classification can produce no trigrams for Chinese text. Correctly indexed nested tool results can therefore be absent from search. A fuzzy alternative can also displace a literal match when the result cap is small.

## Decision

The [conversation repository](../../../../gateway/src/postgres/conversation-repository.ts) accepts a contained literal match or a trigram match within the selected organization. The literal pattern escapes backslash, percent and underscore; blank queries return no rows. Literal matches sort before fuzzy alternatives, followed by similarity and recency. Existing stored search text and the trigram index remain valid.

## Alternatives considered

**Reduce the global similarity threshold.** This retains dependence on database character classification and admits more unrelated events without guaranteeing a literal match.

**Treat query punctuation as wildcard syntax.** Search text is literal input; an ordinary percent or underscore must not broaden the result set.

## Consequences

Ordinary index values retain their literal-search behavior. NUL-bearing text uses the [lossless representation](../architecture/2026-10-30-conversation-nul-search-and-query-fields.md). Very short or unclassified text may require scanning rows within the organization. It does not enable the separately configured Session-query provider or add a product endpoint.

## Verification

The real PostgreSQL regression preserves event JSON and searches nested Chinese tool text, a short query in a long message, literal wildcard characters and backslash. A one-result limit keeps the contained match ahead of a closer fuzzy alternative. The database facts record zero Chinese trigram similarity under the C character classification; both original omission and incorrect fuzzy priority have failed receipts.
