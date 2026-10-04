# Agent Note: 管理语言偏好贯通网关闸口页

Status: implemented

[English](2026-10-04-admin-gate-pages-language-cookie.md) | 中文

## 问题

管理语言缝存于 `localStorage`，服务端渲染页读不到。网关自有闸口页——`gateway/src/html.ts` 的 `loginPage`、`passwordPage`、`waitingPage`、`stoppedPage`，以及 `server.ts`/`proxy.ts` 抛出的登录/锁定/密码长度错误与 `INSTANCE_STOPPED` JSON 消息——全部硬编码中文，英文偏好的管理员在到达 SPA 之前先撞上中文登录页。

## 决策

`setAdminLanguage` 现在同时写 `hgw_lang` cookie（`Path=/`、`SameSite=Lax`、非 `HttpOnly`——仅客户端写它）。`html.ts` 携带一个小型 `GATE_COPY` zh/en 词典，沿用管理词典的键源/键位对齐形态，提供 `gateLanguage(cookieHeader)` 读取器与 `gateCopy(language)` 翻译位；每个闸口页接受语言参数，`layout` 输出对应的 `html lang`。`server.ts` 与 `proxy.ts` 按请求从 Cookie 头解析语言，改传词典解析出的错误文案而不再内联字面量。经报文由服务端模块下发的字符串（`node-config-fields` 标签、归档/文档回退标题、推送通知正文、引导控制台提示）保持中文——它们是没有按请求偏好的报文/运维数据，是产品边界而非遗留欠债。

## 文件

- `gateway/admin-ui/src/language.ts` — `setAdminLanguage` 在 `coharness-admin-language` 之外写 `hgw_lang`。
- `gateway/src/html.ts` — `GatePageLanguage`、`GATE_LANG_COOKIE`、`gateLanguage`、`gateCopy`、`GATE_COPY` 词典；四个页面全部本地化。
- `gateway/src/server.ts` — 登录/锁定/无效与密码长度错误走 `gateCopy`；两个页面按请求语言渲染。
- `gateway/src/proxy.ts` — `stoppedPage`/`waitingPage` 与 `INSTANCE_STOPPED` 消息走 `gateLanguage`/`gateCopy`。

## 影响

`hgw_lang=en` 时登录、改密、运行时启动中、已停止页均渲染英文——已对线上网关实证。从未打开过管理语言选择器的浏览器按 localStorage 默认回落到中文。
