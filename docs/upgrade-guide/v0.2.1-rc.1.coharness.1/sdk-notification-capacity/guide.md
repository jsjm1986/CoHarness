---
kind: upgrade-guide
description: "SDK ancestry capacity is independent of notification queue capacity, and excess ancestry terminates delivery explicitly."
---

# Configure SDK notification and ancestry capacity

English | [中文](guide.zh.md)

## Change

TypeScript and Python SDKs retain active subagent ancestry independently of notification queue capacity. The default ancestry limit is 10000. Exceeding the limit terminates notification delivery with `TransportClosedError`; active ancestors are no longer silently evicted. Filters that close their subscription cannot deliver the current notification to that subscription.

## Migration

1. Keep `maxNotificationQueue` (TypeScript) or `max_notification_queue` (Python) sized for each consumer's queued notifications.
2. Set `maxSessionRelationships` (TypeScript) or `max_session_relationships` (Python) when more than 10000 simultaneous active parent-child relationships are expected. Values must be positive integers.
3. On a relationship-limit error, close the client and create a new one with sufficient capacity. Do not retry through the failed client's incomplete ancestry map.
4. Verify that a root-session subscription receives child and grandchild notifications while its consumer drains the queue, and that a filter closing its own subscription receives no subsequent frame.
