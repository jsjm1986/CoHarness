---
kind: upgrade-guide
description: "The shipped web composition defaults web search to deepseek-search-api; unset projects now use the Search API."
---

# Default web search provider is now `deepseek-search-api`

English | [中文](guide.zh.md)

## Change

The shipped composition seeds `web.searchProvider: deepseek-search-api` (the fetch provider stays `http`). Projects that never chose a search provider previously received `deepseek-official` Messages-API search and now get the Search API's `web_search` tool instead: result shape, `max_uses` default, and `web_search_20250305` API version differ, and Search API requests need a working `DEEPSEEK_API_KEY` credential. Projects with an explicit `web.searchProvider` value keep it unchanged. Selecting the deployment default in Settings now clears the project's stored override instead of writing a duplicate.

## Migration

1. To keep the previous behavior for a project, set `web.searchProvider: deepseek-official` in its settings (Settings → Web Search, or `settings.yaml`).
2. To adopt the new default where it was previously pinned, delete the project's `searchProvider` override or pick the deployment default in Settings; the field is removed, not rewritten.
3. Confirm the active provider: a web search turn writes `web/deepseek-search-llm-request` session events under the Search API, versus Messages-API tool calls under `deepseek-official`.
