---
kind: upgrade-guide
description: Gateway 会话 Cookie 按绝对期限保留在浏览器中，不再在最初的空闲截止时间过期。
---

# Gateway 浏览器会话保留期限

[English](guide.md) | 中文

## 变更

`hgw_session` Cookie 的 `Max-Age` 使用 `HGW_SESSION_ABS_TTL_MS`，向上取整到整秒。`HGW_SESSION_TTL_MS` 控制服务端的滑动空闲截止时间。每次认证时，服务端也会检查最初的绝对截止时间。因此，持续活动可让浏览器会话在最初的空闲周期后继续工作。

既有浏览器 Cookie 保留签发时收到的过期时间。清除 Cookie 时仍发出 `Max-Age=0`。

排队的 PostgreSQL 认证在会话行等待后读取当前权限，并在续期前拒绝任一已到期的期限。SQLite 同样拒绝恰好到达任一期限的令牌。作用域 Cookie 将不足一秒的有效期向上取整，使已选择项目在登录有效时仍可使用。新登录在准入后获得完整的配置有效期；失败尝试时间戳与锁定窗口使用当前数据库时钟。客户端继续使用既有的禁止或未授权响应；这些检查无需数据库迁移。

## 迁移

1. 检查 Gateway 环境中的 `HGW_SESSION_TTL_MS` 与 `HGW_SESSION_ABS_TTL_MS`：默认空闲期限为七天，绝对期限为三十天。
2. 部署更新后的 Gateway。需要立即取得新的浏览器保留期限时，注销后重新登录。
3. 确认新 `hgw_session` Cookie 使用配置的绝对保留期限。活动会话可在最初的空闲周期后继续工作；空闲或绝对过期的会话仍应收到认证拒绝。
