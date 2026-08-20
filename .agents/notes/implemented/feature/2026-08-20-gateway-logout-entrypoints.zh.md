# Agent Note: Gateway 退出登录入口

Status: implemented

[English](2026-08-20-gateway-logout-entrypoints.md) | 中文

## Problem

登录用户无法从 Web 工作台或 `/admin` 管理端结束 Gateway 会话，尽管 Gateway 已经提供完整的 `POST /logout` 路由，负责撤销令牌、写入审计记录、清除会话 Cookie，并重定向到 `/login`。

## Decision

两个浏览器界面都提交原生的同源 `POST /logout` 表单。`/admin` SPA 在桌面侧栏和紧凑移动端顶部渲染该表单。Web 工作台从 Gateway-only 的 `dsh-client-ui-collaboration` 侧栏 footer slot 渲染退出入口，并且只在账户上下文可用后显示，因此本地未认证 Web 模式不会暴露无效路由。浏览器不重复实现令牌撤销或 Cookie 处理；Gateway 仍是唯一会话所有者。

## Consequences

用户端和管理端的退出行为一致，包括审计和重定向语义。原生表单导航不需要客户端 fetch 竞态或第二套 Cookie 清理实现。若账户上下文请求暂时失败或不可用，Web 入口会在协作状态 ready 前隐藏；`/admin` 仍通过自己的认证文档可用。

## Alternatives considered

**使用客户端 `fetch('/logout')` 后手动跳转。** 不采用，因为这会重复重定向和会话清理逻辑，增加浏览器历史与失败处理复杂度，并可能在请求完成前留下过期 UI 状态。

**新增退出 API 或 Cookie 清理辅助函数。** 不采用，因为 Gateway 已在 `POST /logout` 提供权威的撤销、审计和 Cookie 契约。

**本地模式始终显示 Web 退出按钮。** 不采用，因为本地 Web 没有 Gateway 会话路由；现有 Gateway-only 能力的账户上下文状态是更准确的显示条件。
