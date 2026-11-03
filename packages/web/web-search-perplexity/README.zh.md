---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-perplexity

[English](README.md) | 中文

由 [Perplexity](https://perplexity.ai) 支持的 `WebSearchProvider`，用于 harness [web 能力 seam](../web/README.zh.md)（`ctx.web`）。它调用 Perplexity 的 OpenAI 兼容 `POST /chat/completions` 端点，把生成答案与引用映射为 seam 规范化的 `WebSearchResult`。

本实现以 `inject: ['web']` 注册到 `ctx.web`。受管搜索通过选定的 `ctx.llm` 路由执行预备的 `perplexity-web-search` 操作；独立组合保留私有 chat-completions 传输。面向模型的工具属于 `dsh-tool-web`。

## 概述

有了 `dsh-web-search-perplexity`，harness 可以通过 Perplexity 搜索 web，一次调用同时获得模型生成的答案与可引用来源。当部署持有 Perplexity API 密钥、并希望获得生成答案时选择它。Perplexity 没有结果数量控制，因此返回的来源会在事后被截断到请求的上限。Perplexity 省略结构化结果元数据时，来源回退为只含 URL 的引用。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [配置](#config)
- [映射](#mapping)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="config"></a>
## 配置

| 配置键 | 默认值 | 含义 |
|---|---|---|
| `provider` | `perplexity`（受管） | 精确 LLM 路由；配置此项或安装／要求模型策略时启用受管执行。 |
| `apiKey` | 未设置 | 独立传输的密钥；受管执行使用 LLM 路由的凭据。 |
| `apiKeyEnv` | `PERPLEXITY_API_KEY` | 独立传输的凭据引用；优先使用 credentials 服务，否则使用启动环境。 |
| `baseURL` | `https://api.perplexity.ai` | 端点基址；追加 `/chat/completions`。无法解析时提供方不可用。 |
| `model` | `sonar` | 搜索模型名称。 |
| `maxTokens` | `1024` | 生成答案 token 上限（`max_tokens`）。必须是正整数。 |
| `maxResponseBytes` | `16 MiB` | 每次成功或错误响应正文的正安全整数上限（最高 256 MiB）；分块响应超过上限时会被取消。 |
| `searchRecency` | （未设置） | 以 `search_recency_filter` 发送的新近程度窗口：`day`、`week`、`month` 或 `year`。未设置时不发送过滤条件。 |

```yaml
- id: web-search-perplexity
  name: '@deepseek-ai/dsh-web-search-perplexity'
  config:
    apiKeyEnv: PERPLEXITY_API_KEY
```

受管调用使用 LLM 路由的端点、模型和凭据，复用模型策略、资源准入、执行归属与用量中间件。支持的适配器是显式配置的 pi-ai `openai-completions` 路由；其他协议或仅依靠原生登录的目录路由会明确拒绝。独立 `baseURL` 与密钥设置不覆盖受管路由。独立传输在模型许可获批后解析凭据，并在卸载时取消、等待清理。

独立请求在准入和凭据等待期间保留资源提供者，并在 HTTP 前重新检查当前归属和模型策略要求。提供者被移除、替换或新增准入时，以 `WEB_PROVIDER_ERROR` 拒绝过期派发，并把未使用的容量归还原所有者。新增必需模型策略也会拒绝独立派发。恢复授权后应重新搜索。在请求记录前拒绝时，不向发起 Session 添加原生输入。

<a id="mapping"></a>
## 映射

`content` ← `choices[0].message.content`（生成答案）。`sources[]` 优先使用结构化 `search_results[]`（`url`、`title`、`snippet`、`publishedAt` ← `date`），否则回退到只含 URL 的 `citations[]` 数组；仅当不存在 `search_results` 时才采取这条回退路径。这些源只携带 `url`，因此 seam 上的 `title`／`snippet`／`publishedAt` 是可选字段。提供方失败以 `WebError` `WEB_PROVIDER_ERROR` 呈现；中止请求以 `WEB_ABORTED` 呈现。HTTP 重定向会在访问 `Location` 指向的目标之前被拒绝，并以 `WEB_PROVIDER_ERROR` 呈现。Perplexity 没有结果数量控制，因此 seam 会强制执行 `maxResults`（截断 `sources[]` 并设置 `truncated`）。

<a id="model-experience"></a>
## 模型体验

### 辅助 Perplexity 请求

#### 模型看到的内容

独立的 Perplexity 模型通过 chat-completions 端点将 `<query>` 原样作为唯一用户消息接收。该请求不属于会话模型上下文。 精确端点与 JSON body 在派发前记入 `web/perplexity-search-llm-request`；受管执行在模型检查点前追加该事件。

#### Token 影响

每次搜索都会产生独立的提供方 token；`maxTokens` 限制生成答案。受管执行报告实际输入／输出计数和凭据来源；缺失用量保持缺失。

#### KV Cache 影响

与会话请求缓存相互独立。同一模型路由下的相同查询可能复用提供方缓存；查询或路由改变会建立不同前缀。

### 间接的会话工具结果

#### 模型看到的内容

通过 `dsh-tool-web`，会话模型会看到生成答案及结构化结果元数据，或只含 URL 的引用。该提供方确切的错误消息为 `Perplexity search aborted`、`Perplexity search request failed: <error>` 和 `Perplexity returned an unprocessable response body: <error>`；HTTP 失败保留提供方消息。错误包装层属于消费方。

#### Token 影响

注册不会直接产生会话 token。答案与来源 token 取决于数据，来源数量受服务限制；保留的结果或错误会重复发送，直到发生压缩（compaction）。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与暂缓事项

- **引用回退源只含 URL**：Perplexity 省略结构化 `search_results[]` 时，源不含 `title`／`snippet`／`publishedAt`，因此工具只渲染纯主机名标签。
- **超量返回的来源仍会增加 token 消耗和延迟**：协议没有结果数量控制，`maxResults` 只能由 seam 在事后截断。
- **只公开 `model`／`maxTokens`／`searchRecency`**：Perplexity 的其他搜索控制项（域名过滤条件、`web_search_options` 上下文大小、图片）有待提供方无关的 Service Definition 字段支持（见 [seam Agent Note](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)）。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
