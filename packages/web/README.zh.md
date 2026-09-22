# web/：web 能力家族

[English](README.md) | 中文

本家族提供与提供方无关的 web 搜索和抓取操作，以及消费这些操作的面向模型工具。

| 包 | 职责 | ctx key |
|---|---|---|
| [`web/`](web/README.zh.md) | 定义 web 提供方注册、选择和共享错误 | `ctx.web` |
| [`web-search-exa/`](web-search-exa/README.zh.md) | 通过 Exa 提供 web 搜索 | 注册到 `ctx.web` |
| [`web-search-perplexity/`](web-search-perplexity/README.zh.md) | 通过 Perplexity 提供 web 搜索 | 注册到 `ctx.web` |
| [`web-search-deepseek/`](web-search-deepseek/README.zh.md) | 提供 DeepSeek 原生 web 搜索 | 注册到 `ctx.web` |
| [`web-fetch-http/`](web-fetch-http/README.zh.md) | 抓取公共 HTTP 和 HTTPS 资源 | 注册到 `ctx.web` |
| [`tool-web/`](tool-web/README.zh.md) | 向模型公开 web 搜索和抓取 | 注册到 `ctx.tools` |

[web 能力决策](../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)记录了搜索和抓取共用一项提供方选择服务的原因。

子系统参考——搜索/抓取请求与结果、可用性、`WebError`——见 [docs/subsystems/web.md](../../docs/subsystems/web.zh.md)；依据（含延后的 SSRF 防护）见 [web 能力 seam Agent Note](../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)。


## 概述

`web/` 包让模型通过 `web_search` 与 `web_fetch` 工具搜索公共 web 和抓取 HTTP(S) 页面。部署可为搜索选择 Exa、Perplexity 或 DeepSeek，并通过匿名 HTTP(S) 访问抓取页面；可用性与资源上限取决于配置的提供方。该家族用于搜索和页面检索，不用于交互式浏览、内容提取或逐 URL 策略执行。提供方变化时，模型仍能获得一致的工具行为、取消与错误报告。
