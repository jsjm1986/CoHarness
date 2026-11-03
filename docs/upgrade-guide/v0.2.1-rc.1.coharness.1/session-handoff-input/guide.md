---
kind: upgrade-guide
description: "Handoff extraction adds a required Session event that older readers do not recognize."
---

# Read recorded handoff model inputs

English | [中文](guide.zh.md)

## Change

Auxiliary `session_handoff` extraction records its source Session, requested provider/model and complete input messages in a log-only `session/handoff-llm-request` event before model streaming. Older builds that do not recognize this required event refuse affected logs. Current readers retain existing event support. The Session header version and structural format are unchanged; no committed generation is rewritten.

## Migration

1. Rebuild and deploy matching Runtime, Gateway, Web and archive readers from the same source tree, including the generated Session event vocabulary and query-tool package. Keep input recording and the matching reader together.
2. Confirm that a new handoff log contains `session/handoff-llm-request` and opens through the matching reader. The TypeScript and Python keyless handoff SDK fixtures verify physical-dispatch ordering and persisted readback. Do not remove the event or overwrite a committed generation to use an older reader.
