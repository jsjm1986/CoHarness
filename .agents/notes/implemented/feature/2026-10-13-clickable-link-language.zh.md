# Agent Note: 统一可点链接语言并落地画廊 e2e

Status: implemented

[English](2026-10-13-clickable-link-language.md) | 中文

## 问题

本地已携带 `LinkIcon` 原语与 `--dsw-alias-link` 令牌但从未消费：markdown 锚点、文件提及、`WebBlock` 来源/抓取链接、产出文件 chip 与 `WorkflowRunPanel` 成员标签各持自己的颜色、字重与下划线处理，且没有任何链接带 `LinkIcon` 引导字形。移植上游 clickable-links-gallery e2e 同时暴露一个真实产品 bug:Settings 的链接打开方式行从不渲染——`ui-conversation` 在 apply 时一次性探测 `ctx.reflect.get('sidebarRightTabs')`，而客户端 entry 并发创建，每次启动注册表都晚于探测落地。上游来源:`8ffdee4fe5d`(链接语言 + 画廊）与 `3eab1714bcd`（链接打开偏好），均只在 alpha.2。

## 决策

五个链接面统一为同一语言:`--dsw-alias-link` 颜色、`font-weight: 500`、静止无下划线、hover/focus 时 dotted 下划线偏移 3px。`LinkIcon` 引导每个 markdown 锚点（`MarkdownAnchor`/`renderSafeLink` 接受 `glyph` 标志，纯图锚点保持无字形）、每个 text-node 文件提及、每个 `MarkdownFileLink`、每个 `WebBlock` `SafeLink` 与每个产出文件 chip;`classifyLinkPath` 按面挑选类别字形。inline-code chip 令牌移入 `neutral-50`/`neutral-800` 并获得 0.5px 边框，使 URL 提升的行内代码在独立 chip 内读作链接。

产出文件 chip 去掉灰底胶囊与 96px 上限：在 flex 行内按自然宽度渲染，仅在溢出时带省略号收缩;container-query 分档仍按 96px 预算决定展示几个 chip。`show-in-folder` 变为同一链接形式并带文件夹字形。`WorkflowRunPanel` 成员标签取共享链接处理。工具行 dotted 文件链接与通用灰色 affordance 保持原样——上游有意把它们排除在新语言之外。

Settings 行改为在 `ctx.inject(['sidebarRightTabs'], scope => ...)` 内注册:ui-sidebar-right 提供注册表的瞬间贡献出现、离开即消失，对并发 entry 创建免疫。注册表类型保持本地结构式接口——ui-sidebar-right 的 project reference 指回 ui-conversation，类型化 Context 合并会闭合引用环。

`apps/web/tests/clickable-links-gallery.e2e.ts` 移植上游画廊：一个种子化无密钥回合覆盖 plain/reference/mailto/inline-code 锚点、`javascript:`/ftp/命令代码等 inert 对照、远程图片、唯一基名 vs 歧义/未写文件提及、工具行文件链接（含失败写入与未分类工具排除）、折叠 `web_fetch` URL 链接、安全 HTTP(S) 来源链接、generic 行展开、经真实 settings provider 的 sidebar-versus-new-tab 设置往返（含 reload 与会话重选）、computed-style 断言（链接颜色、字重、静止/hover 装饰、引导字形）与稳定 ARIA 快照。`nativeOpen` overlay 使 show-in-folder 分支在 CI 与桌面宿主机上表现一致。

## 备选方案

**在 web patch 中把 `ui-sidebar-right` 排到 `ui-conversation` 之前。** 否决:`client/modules` 并发创建 entry，列表顺序不串行化 apply,race 依旧存在；上游的 `ctx.inject` 门才是真正等待服务的机制。

**在 `getSnapshot` 内等待注册表。** 否决：快照可以懒读，但注册表到达时没有任何东西通知订阅者——行在首帧仍渲染缺失。inject 门重新注册贡献本身。

## 影响

转录中每个可点产物读作同一语言，画廊 e2e 端到端钉住它。没有 `ui-sidebar-right` 的装配不显示链接打开行而不是挂一个死偏好。上游后续的 `LinkIcon` 演化——`7520fe94e14` 的 `siteGlyph` favicon 变体与 `LinkIconMedium`——未移植；本地原语保持 `8ffdee4fe5d` 基线，作为相邻缺口记入审计。

## 验证

`link-icon`/`markdown-dom-parity`/`markdown-file-links`/`web-block`/`produced-files` spec 通过（`ui-primitives`、`ui-deliverables`、`ui-workflow-run` 共 1130 测试）,markdown-dom fixture 已再生成并覆盖语料中新增的纯图锚点用例。`chat-apply.client.spec.tsx` 在 bench 提供注册表并新增生命周期用例：无注册表无行、插件提供后出现、dispose 后消失。画廊 e2e 在 replay 模式对已提交 golden 通过，零页面错误、零控制台告警。

## 相关

- `../architecture/2026-09-20-upstream-alpha2-client-lane-audit.md` — 本批服务的对齐审计。
- `../bug-fix/2026-10-15-web-fetch-summary-url-link.md` — 画廊覆盖的折叠行 URL 锚点。
