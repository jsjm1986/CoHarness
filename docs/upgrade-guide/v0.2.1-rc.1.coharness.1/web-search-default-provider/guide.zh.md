---
kind: upgrade-guide
description: "出厂 web 组合默认搜索 provider 改为 deepseek-search-api;未配置的项目改用 Search API。"
---

# 默认 web 搜索 provider 改为 `deepseek-search-api`

[English](guide.md) | 中文

## 变更

出厂组合播种 `web.searchProvider: deepseek-search-api`(fetch provider 仍为 `http`)。此前从未选择搜索 provider 的项目原先获得 `deepseek-official` Messages API 搜索,现在改用 Search API 的 `web_search` 工具:结果结构、`max_uses` 默认值与 `web_search_20250305` API 版本均不同,且 Search API 请求需要可用的 `DEEPSEEK_API_KEY` 凭据。显式设置了 `web.searchProvider` 的项目不受影响。在设置中选择部署默认值现在会清除项目层覆盖,而非写入重复值。

## 迁移

1. 要为项目保留原行为,在其设置中设 `web.searchProvider: deepseek-official`(设置 → Web 搜索,或 `settings.yaml`)。
2. 要在曾锁定旧值的项目上采用新默认,删除项目的 `searchProvider` 覆盖项,或在设置中选择部署默认值;该字段会被移除而非重写。
3. 确认生效的 provider:一次 web 搜索轮在 Search API 下写入 `web/deepseek-search-llm-request` 会话事件,在 `deepseek-official` 下则是 Messages API 工具调用。
