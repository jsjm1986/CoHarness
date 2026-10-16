# Agent Note: 折叠的 web_fetch 行链接其 URL

Status: implemented

[English](2026-10-15-web-fetch-summary-url-link.md) | 中文

## Problem

折叠的 `web_fetch` 行把请求 URL 显示为普通摘要文本，用户必须先展开行、再通过卡片的链接才能打开抓取的页面。上游修复为 `61a0ed487eb`。

## Decision

`webFetchHref` 从调用的已解析参数推导链接目标，仅对 `url` 能以 `http:` 或 `https:` 协议解析的 `web_fetch` 调用返回结果；其他工具、协议或无法解析的参数仍保持纯文本。`WebRow` 把结果传给 `ToolRow` 新增的 `href` 属性，后者把摘要渲染为在新标签页打开的锚点（`rel="noopener noreferrer"`），并阻止点击与 Enter/Space 事件冒泡，使链接不会触发行展开。出错或停止的行抑制该链接——其摘要是错误文案而非 URL。文件路径按钮保留自己的宿主打开路径，不受影响。

## Alternatives considered

**为任何参数含 URL 的工具链接摘要。** 只有 `web_fetch` 的调用契约是整个摘要即 URL；其他工具的摘要混合文案与值，因此按工具显式推导，而非启发式处理。

**复用展开卡片的链接数据。** 卡片模型读取已定稿的 `resultView`；摘要链接需要调用参数——运行中也存在——因此助手经 `parsedToolCall` 读取 `args`，即摘要文本使用的同一校验器。

## Consequences

点击折叠的 URL 在新标签页打开页面而不展开行；点击行内其他位置仍展开行。本地没有 `clickable-links-gallery` e2e，覆盖由聚焦的 `web-card.client.spec.tsx` 套件承担。安全规则——绝不把非 http(s) 协议渲染为链接——现在集中于各生命周期状态共用的一个助手中。

## Verification

`web-card.client.spec.tsx` 覆盖 `webFetchHref` 的 http/https 接受、非 http 与不可解析拒绝、缺失调用及非 fetch 工具，以及渲染锚点的 `href`/`target`/`rel`、点击与 Enter 不展开行、错误行保持纯文本。`ui-tool` 全量套件与包 typecheck 通过。

## Related

- [2026-08-23 Client-derived tool presentation](../architecture/2026-08-23-client-derived-tool-presentation.zh.md) — 拥有 web 卡片的定稿结果模型；本链接改为读取调用参数。
