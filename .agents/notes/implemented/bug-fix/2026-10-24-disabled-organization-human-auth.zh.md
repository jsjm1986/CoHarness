# Agent Note: 停用组织的用户认证

Status: implemented

[English](2026-10-24-disabled-organization-human-auth.md) | 中文

## 问题

Gateway 就绪检查不能确定后续用户请求发生时组织的当前状态。只检查用户和成员身份，会使组织停用后仍可通过新登录与既有 Cookie 授权请求。

## 决定

PostgreSQL 用户认证在初始登录查询、密码验证后的身份复查以及每次 Cookie 校验时，都要求组织处于活动状态。拒绝沿用既有的登录无效或未认证响应，不披露组织状态。密码验证期间停用组织时，验证后的复查同样拒绝登录。

## 曾考虑的替代方案

**依赖启动就绪检查。** 运行中的 Gateway 必须无需重启就能读取状态变化。

**只检查新登录。** 既有 Cookie 仍会继续授权停用组织的请求。

## 后果

停用组织会阻止后续用户登录和 Cookie 校验通过认证。此检查不会永久撤销已存储的会话：组织重新启用后，尚未过期的会话仍可能授权请求。已准入流量的取消继续由[访问失效机制](../architecture/2026-09-22-cross-gateway-access-invalidation.zh.md)负责。真实 HTTP/PostgreSQL 回归覆盖新登录、既有 Cookie 和密码验证期间停用组织的情况。

组织检查与[按区域规则生成登录键](2026-10-23-case-insensitive-login-admission.zh.md)的组合在原生 Node 25.8.1、macOS arm64、经本机 TCP 连接的 PostgreSQL 17.6 上测得以下结果：一个活动成员、连接池大小为一，每个版本使用三个独立进程，每个进程运行三批。Cookie 每批 200 次，登录每批 20 次。Cookie 校验中位数为每次 2.574 → 2.547 ms，峰值及 GC 后 RSS 为 80,048 → 79,904 KiB。登录为每次 27.712 → 28.604 ms，峰值 RSS 为 88,864 → 90,880 KiB，GC 后 RSS 为 88,800 → 90,880 KiB。登录路径增加一次数据库规范化查询。诊断不含 HTTP 传输、数据库服务端内存及并发负载。构建 Gateway 后，在其目录中设置 `HGW_TEST_DATABASE_URL` 指向可丢弃数据库，运行 `TSX_TSCONFIG_PATH=tsconfig.run.json node --import tsx/esm tests/auth-admission.perf.ts`；基线仅从编译模块中移除这些检查。
