---
description: "ctx.web 的 DeepSeek 搜索提供方：部署方如何通过 Anthropic 兼容 Messages API 挂载 DeepSeek 原生 web 搜索，并逐次解析凭据。"
kind: "package-reference"
---

# @deepseek-ai/dsh-web-search-deepseek

[English](README.md) | 中文

## 概述

有了 `dsh-web-search-deepseek`，harness 可以通过 DeepSeek 原生搜索检索 web，使用 DeepSeek 账号登录或部署已有的 `DEEPSEEK_API_KEY`。当部署希望使用 DeepSeek 原生搜索、并接受一次搜索在延迟与 token 上消耗一个完整模型轮次时选择它；[dsh-web-deepseek-api](../web-deepseek-api/README.zh.md) 中的 DeepSeek Search 与 Fetch API 无需模型轮次即可检索。结果来自 DeepSeek 返回的结构化搜索块，绝不会从回复文本中抓取。凭据缺失时调用以结构化错误失败；响应缺少搜索结果块时会明确报错，而非降级。面向模型的 `web_search` 工具位于 `dsh-tool-web`。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

在已加载 web 服务的组合中挂载本提供方；它以 `deepseek-official` 搜索提供方身份注册，因此当它是唯一可用的搜索后端时，`ctx.web.search()` 会自动解析到它——也可以用 `searchProvider: deepseek-official` 固定。

### 何时选择

需要在兼容 DeepSeek 的 Messages 路由上进行原生服务器搜索时选择本后端。每次搜索执行完整模型回合，最多调用 `maxUses` 次服务器搜索。受管部署选择已配置的 LLM 提供方；独立 web 组合可使用独立的 API key 端点。

### 最小配置

加载 web 服务和提供方。配置 `provider`，或已安装、要求模型授权时，搜索使用选定的 LLM 路由；默认路由为 `deepseek-official`，端点与凭据由其适配器拥有。不满足这些条件时，下列配置通过 `ctx.credentials` 或启动环境解析自己的密钥，并独立于会话设置读取 `DEEPSEEK_SEARCH_BASE_URL`。

```yaml
- name: '@deepseek-ai/dsh-web'
- name: '@deepseek-ai/dsh-web-search-deepseek'
  config:
    apiKeyEnv: DEEPSEEK_API_KEY
    baseURL: https://gateway.internal/anthropic/v1
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | 省略 | 受管 LLM 路由。该路由必须实现原生 Messages 搜索；不支持的协议或原生登录鉴权会明确失败 |
| `apiKey` | 省略 | 独立搜索的 API key；优先使用 `apiKeyEnv`。非空字面量优先于 `apiKeyEnv`；受管搜索使用 LLM 路由凭据 |
| `apiKeyEnv` | `DEEPSEEK_API_KEY` | 每次搜索通过 `ctx.credentials` 解析的凭据引用；没有该服务时从进程环境解析。需要 API 密钥却解析不到时，搜索以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败 |
| `baseURL` | `https://api.deepseek.com/anthropic/v1` | 独立搜索的 Messages 根地址；追加 `/messages`，回退到 `$DEEPSEEK_SEARCH_BASE_URL`。受管搜索使用选定 LLM 路由的端点 |
| `model` | `deepseek-v4-flash` | Anthropic 格式模型名称 |
| `apiVersion` | `2023-06-01` | `anthropic-version` 标头值 |
| `maxTokens` | `4096` | Messages 请求生成 token 的正整数上限 |
| `maxUses` | `5` | 每次请求使用 `web_search` 服务器工具的正整数上限 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-deepseek) 列出所有接受的字段。每次搜索从即时 Config 引用捕获选项。

<a id="authentication"></a>
### 鉴权

受管搜索保留预备 LLM 路由的端点、模型、凭据引用和标头。凭据只在获准执行时解析；独立的 `apiKey`、`apiKeyEnv` 与 `baseURL` 不覆盖该路由。DeepSeek API key 直连路由和显式配置的 pi-ai Messages 路由实现此操作。提供方原生登录和其他协议无法为该原生请求鉴权时会明确失败。

独立搜索先解析非空 API key 字面量，再解析凭据引用，并同时发送 `x-api-key` 与 `Authorization: Bearer`。传输类也接受适配器拥有的 `resolveHeaders`，由它独占提供鉴权标头，不回退到账号或密钥。

### 搜索返回什么

`content` 始终省略：DeepSeek 的提供方文本不作为答案受到信任。`sources[]` 来自 `web_search_tool_result` 块内的 `web_search_result` 条目——`url` 和 `title` 直接取自同名字段，`publishedAt` 取自 `page_age`——snippet 在存在摘录时按 URL 关联的 `cited_text` 条目拼接。结果按 URL 去重，且由于 DeepSeek 不公开结果数量旋钮，服务通过截断并标记来强制执行 `maxResults`。

### 请求日志

受管搜索经过普通 LLM 中间件、精确路由授权、执行归属、模型准入和实际用量报告。在任何等待前捕获发起 Session。排队时撤销模型或执行权限会阻止 HTTP 派发；缺少必需策略不会恢复独立派发。每个请求只取得一个模型许可，持有到响应处理和取消结束。卸载中止并等待已接受搜索及清理。

独立搜索在准入和凭据等待期间保留资源提供者，并在派发前核对当前归属和模型策略要求。提供者被移除、替换或新增准入时，过期 HTTP 以 `WEB_PROVIDER_ERROR` 拒绝，未使用的容量归还原所有者。新增必需模型策略也会阻止独立派发。应恢复授权并重新搜索，不转移旧许可。在记录之前被拒绝的请求不会向发起 Session 添加原生输入。

存在发起 Session 时，`web/deepseek-search-llm-request` 记录精确端点、API 版本和无密钥请求体。受管搜索在进入模型中间件前追加，使 checkpoint 策略能在 HTTP 前完成持久化；拒绝的尝试保留已记录输入。独立搜索在鉴权和准入之后、HTTP 之前追加。不记录标头和凭据。实际提供方用量在结果映射前报告；缺失用量保持缺失。

### 失败与恢复

失败抛出 `WebError`：独立搜索缺少凭据使用 `WEB_PROVIDER_CREDENTIAL_MISSING`，取消使用 `WEB_ABORTED`，模型策略、提供方或传输失败使用 `WEB_PROVIDER_ERROR`。原始模型失败保留为 cause，供程序检查。重定向会在联系目标前拒绝。派发后失败指出精确端点；受管搜索引导用户检查拥有该端点的模型路由设置，独立搜索引导用户检查 Web search 设置。模型不得选择或更改端点。错误包装由 `web_search` Consumer 拥有。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释提供方背后的设计决策；可观察行为已在[使用本包](#use-this-package)中完整说明。

### 设计理念

本提供方建立在两项承诺之上：

- **只取结构化块。** DeepSeek 在服务端执行搜索并返回结构化的 `web_search_tool_result` 块；提供方解析这些块，绝不从模型文本中抓取 URL。严格模式下，没有此类块的响应会抛出 `WEB_PROVIDER_ERROR`，而非降级。
- **会话凭据，逐次解析。** 提供方不新增密钥：来自账号路由会话的搜索使用该账号的 token，其余搜索复用 `DEEPSEEK_API_KEY` 引用。辅助请求端点通过 `$DEEPSEEK_SEARCH_BASE_URL` 保持独立。已挂载的凭据服务具有权威性；没有该服务时回退到启动进程的环境。按次解析意味着在 Web 的 Models 页中存储或轮换的密钥，或一次账号登录，无需重启即可用于下一次搜索。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | Config schema 与每次搜索的选项捕获 |
| [`src/admission.ts`](src/admission.ts) | Session 捕获、模型准入与已接受搜索清理 |
| [`src/provider.ts`](src/provider.ts) | `DeepSeekSearchProvider`：Messages 请求分发、块解析、引用拼接、凭据解析 |
| [`src/usage.ts`](src/usage.ts) | 校验实际提供方 token 计数，不虚构缺失用量 |
| [`src/types.ts`](src/types.ts) | 搜索响应的 Anthropic 协议类型 |

### 请求流程

受管搜索在选定 LLM 路由上预备并记录原生操作。独立搜索在准入后解析独立选项。两者共用 Messages 序列化与结果映射：`web_search_tool_result` 提供来源，引用提供 snippet，web 服务负责去重和来源数量限制。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级约定不够用时阅读以下页面。它们从共享词汇逐步进入服务、面向模型的工具与设计依据。

- [web 子系统](../../../docs/subsystems/web.zh.md)——穷尽式的搜索请求／结果词汇与错误码。
- [web 包映射](../README.zh.md)——七包家族与各角色。
- [dsh-web](../web/README.zh.md)——本提供方注册进入的 web 服务。
- [dsh-tool-web](../tool-web/README.zh.md)——渲染本提供方来源的面向模型 `web_search` 工具。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-web-search-deepseek)——每个受支持配置字段及其源声明。
- [web 能力 seam 决策](../../../.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.zh.md)——搜索与抓取为何共用一项提供方选择服务。

-----

## 模型体验

### 辅助 DeepSeek 搜索请求

#### 模型看到的内容

独立的 DeepSeek 模型会原样接收 `Perform a web search for the query: <query>` 作为用户文本，并收到一个原生 `web_search` 服务器工具定义，思考模式关闭。该请求不属于会话模型上下文。

#### Token 影响

每次搜索都会产生独立的提供方输入与输出 token；关闭思考模式不产生推理 token，`maxTokens` 限制生成输出，`maxUses` 限制原生搜索次数。

#### KV Cache 影响

与会话请求缓存相互独立。辅助指令与原生工具定义可以形成稳定前缀，但查询或模型路由的每次变化都会阻止从首个差异起的复用。

### 间接的会话工具结果

#### 模型看到的内容

通过 `dsh-tool-web`，会话模型会看到结构化搜索块中去重后的 URL、标题、日期与引用 snippet；提供方文本不会作为答案受到信任。该提供方的具体失败消息包括带有处理指引的凭据缺失消息（其中也提到 DeepSeek 账号登录）、`DeepSeek search credential resolution failed: <error>` 和 `DeepSeek search aborted`。账号鉴权的搜索收到 HTTP 401 时，会追加引导用户重新登录 DeepSeek 的指引。其他请求、HTTP、原生搜索和响应正文失败会追加已解析端点及前述条件式配置指引。错误包装属于消费方。

#### Token 影响

注册不会直接产生会话 token。结果 token 随返回源与 snippet 增长，随后服务强制执行请求的来源上限。

#### KV Cache 影响

仅追加；新可见内容位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。

<a id="known-limitations-and-deferred-work"></a>
## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制说明提供方在哪些情况下昂贵或不完整。它们是当前包约束。

- **一次搜索消耗一个完整的 Messages 模型轮次**——产生延迟与生成 token，最多执行 `maxUses` 次服务端搜索；[dsh-web-deepseek-api](../web-deepseek-api/README.zh.md) 改用专用的 Search API。
- **动态凭据的可用性在操作内部解析**——同步可用性检查可以确认解析器存在，但无法查询异步凭据存储，因此选中的无密钥提供方会使搜索以 `WEB_PROVIDER_CREDENTIAL_MISSING` 失败；稳定的 `web_search` schema 仍保持注册。
- **超量返回的来源仍消耗 token**——协议没有结果数量旋钮，`maxResults` 只能由服务在事后截断。
- **来源通常没有 `snippet`**——只有当文本块引用（`cited_text`）匹配其 URL 时，来源才会获得 snippet，而 DeepSeek 的 Anthropic 兼容端点返回的文本块不带 `citations`。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

本开发备注是维护者的工作上下文：开放问题与尚未决定的探索方向。它明确不具权威性——已交付的行为、限制与既定理由以上文和相关 Agent Note 为准。

#### 专用检索端点

无需完整模型轮次的 DeepSeek Search 与 Fetch API 位于 [dsh-web-deepseek-api](../web-deepseek-api/README.zh.md)，由网页搜索设置页的开关选择；在 Search API 正式发布公告之前，本提供方仍是默认值。

</details>

<a id="model-experience"></a>
