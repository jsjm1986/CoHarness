# Agent Note: 多电脑转发、治理快路径与 Admin 无重载切换

Status: implemented

[English](2026-11-23-multi-computer-latency-and-ux-optimization.md) | 中文

## 问题

多电脑部署将浏览器访问远端电脑的流量经由中心 Gateway 转发，同时每台远端 Gateway 需要跨高延迟隧道访问中心 PostgreSQL 治理库。此前每条冷建服务流都会在远端触发一次跨隧道 `authorizeChannel` 查询，空闲池默认每节点仅 2 条且任何组织级失效都会清空全部节点的空闲池，`LISTEN` 健康态下节点仍每秒轮询数据库。浏览器 JSON 响应与远端 `/plugins/*` 资源包未经压缩与缓存直传，Web 终端交互写入落入完整代理准入和多语句 SQL 授权，冷启动 `/api/prepare/v1/*` 依赖固定两秒轮询，转发请求在双端重复执行 `monitor.synchronize()` 且转发态 `node_content` 项目读无法走 `readySession` 快路径，项目与 `node_content` 运行时的模型轮次在首字前要执行多轮串行治理查询及第二次状态往返，Admin 管理台切换电脑还会触发整页浏览器重载。

## 决策

`gateway/src/node-service-http-pool.ts`、`gateway/src/node-service-proxy.ts`、`gateway/src/node-service-stream.ts`、`gateway/src/http-compression.ts` 与 `gateway/src/runtime-assets.ts` 中的转发与传输层在不放宽鉴权的前提下压缩隧道往返与传输体积。空闲 HTTP 连接池默认上限调整为 `httpMaxIdleConnections = 32` 与 `httpMaxIdlePerNode = 6`，组织级或用户级失效不再清空健康节点连接池，远端桥接身份校验采用带失效联动和单飞去重的本地缓存（`HGW_NODE_SERVICE_IDENTITY_CACHE_MS`，默认 `5000`），`LISTEN` 健康态下权限失效轮询放宽至 `HGW_ACCESS_INVALIDATION_HEALTHY_POLL_MS`（默认 `15000`）并在监听断开时自动回退快速轮询。超过 1024 字节的重型 JSON 响应按需协商 Brotli 或 gzip 压缩，同时保留 `vary` 请求头并排除流式响应。中心节点在严格完成 `qualify()` 与 `monitor.synchronizeTo()` 后按 `HGW_RUNTIME_ASSET_CACHE_MAX_BYTES`（默认 `33554432`）有界缓存远端不可变 `/plugins/*` 响应体，收到节点失效时驱逐，并在 `GET /admin/api/performance` 暴露转发、连接池与缓存统计计数。

远端准入、冷启动探测与跨节点扇出减少冗余隧道等待。`gateway/src/access-invalidation.ts` 维护实时修订并提供 `ensureAtLeast(revision)`，签名转发声明（`gateway/src/forwarded-principal.ts`）携带中心已核验的 `accessRevision`，远端 `LISTEN` 游标已追平时直接跳过跨隧道 `synchronize()`。`gateway/src/runtime-asset-admission.ts` 在重新核验签发密钥与修订的前提下，将转发态 `node_content` 项目读纳入 `readySession`。`gateway/src/instances.ts` 采用递增步进 `[50, 100, 150, 200, 300]` ms 探测新启动运行时，`gateway/src/proxy.ts` 在冷启动 `/api/prepare/v1/*` 上执行有界服务端短等（`HGW_RUNTIME_PREPARE_WAIT_MS`，默认 `1500`）并返回 `retry-after: 1`。交互终端写入与缩放（`/api/terminal/write`、`/api/terminal/resize`）以 `interactive` 优先级进入 `readySession`，`gateway/src/execution-identity.ts` 将个人终端授权折叠为单条自动提交 CTE。跨电脑文档总览（`gateway/src/browser-documents.ts`）并发度提升至 `6`，`workbench.ts` 与 `beforeStart` 中的独立准备工作并行执行。

`gateway/src/postgres/model-governance-service.ts`、`gateway/src/runtime-resource-api.ts`、`gateway/src/execution-identity.ts` 与 `gateway/src/postgres/instance-repository.ts` 将模型首字治理快路径扩展至项目与 `node_content` 运行时。`resolveRuntimeCredential` 在单条语句内结合项目活跃态与集群服务/纪元围栏解析个人、企业托管项目及 `DSH_PROJECT_*` 凭据；`instance-repository.ts` 在原有延迟写入门控下同步缓存项目 `RuntimeCredentialSubject`；立即生效的受控模型授权内联预留后 `authorizeSession` 确认（`x-hgw-resource-qualified-grant: 1`），排队调用附带变更游标；`execution-identity.ts` 将项目范围、参与者、管家策略、成员关系及 `node_content` 落盘校验压缩为两条 SQL。`gateway/src/operation-timing.ts` 通过 `ResourceLease.operationId`、`ModelAttemptTiming.resourceOperationId` 以及 `enterOperationId`/`authorizeOperationId` 贯通跨日志时序关联。

Admin SPA（`gateway/admin-ui/src/App.tsx`、`ComputerSelector.tsx`、`pending-edits.tsx`、`deployment-context.tsx`、`pages/DeploymentPage.tsx`）将 `DeploymentContextProvider` 与 `ComputerSelectorProvider` 提升到按电脑区分键值的 `RouterProvider` 之上，使无未保存修改时的切电脑操作在 SPA 内原地切换历史与路由，不再整页重载或重拉拓扑与电脑目录；存在未保存表单时保留确认对话框与新标签页回退。窗口 `focus` 与 `visibilitychange` 被动刷新增加 2 秒节流，而显式策略变更事件保持立即刷新。[生产部署手册](../../../../gateway/deploy/README.zh.md)同步记录了 HTTP/2、upstream keepalive、压缩、禁用响应缓冲、WebSocket 升级映射与多电脑 Gateway 调优参数。

## 考虑过的替代方案

**关闭中心侧 `entryReadRelease` 或响应前鉴权。** 去掉中心侧响应头后的二次复核会削弱运行时重启检测并破坏版本化节点服务契约。保留中心本地 PostgreSQL 校验在几乎不增加延迟的同时守住安全边界。

**在 `qualify()` 之前返回缓存的远端 `/plugins/*` 资源或不保留 `vary` 头。** 在请求准入前命中缓存会绕过按用户与节点的访问控制。坚持先完成 `qualify()` 与 `monitor.synchronizeTo()` 再读取缓存，确保每次命中都遵守实时权限与编码协商。

**立即把按击键发送的 Web 终端写入改造成全新的双向 WebSocket 协议。** 在前端、Host 与 Gateway 之间引入平行终端输入帧协议会扩大线协议面并复制会话吊销逻辑。通过 `readySession` 路由交互终端路径并辅以单句 CTE 授权，在保持既有 `stream-principals` 语义不变的前提下立即削减多次隧道往返。

**在 Admin UI 中改用单个包含 `/computers/:id/*` 嵌套路由的全局 `createBrowserRouter`。** 改写全部页面的 `<NavLink>`、`<Link>` 和相对 `useLocation().pathname` 消费方波及面过大。在常驻的 `DeploymentContextProvider` 与 `ComputerSelectorProvider` 之下挂载按电脑键控的 `RouterProvider`，既消除整页重载与重复上下文请求，又完整保留既有路由约定。

## 结果

在可复现的多电脑基准（`gateway/tests/multi-computer-latency.perf.ts`，模拟远端隧道 PostgreSQL RTT 40 ms、中心 4 ms，按 ×5 折算 200 ms 生产隧道）中，6 并发首屏请求将远端跨隧道 `authorizeChannel` 由 6 次降至 1 次、远端 `accessSync` 由 6 次降至 0 次；10 次连续热态 `/api/terminal/write` 中位延迟下降约 60%（40 ms RTT 下约 150 ms 降至约 60 ms，对应 200 ms 隧道约 750 ms 降至约 300 ms）；无关用户失效不再触发重连（`poolOpened: 0`，突发延迟降约 70%）；双路 WebSocket 升级中位延迟下降约 72–79%；3 节点文档总览提速约 3 倍；远端 `/plugins/combo.js` 缓存热命中延迟下降约 75–86%，传输字节通过 `br` 减少 98.2%。个人终端授权由 11 条串行 SQL 压缩为 1 条，活跃态项目与 `node_content` 模型轮次消除了整轮状态 HTTP 往返及多次跨隧道治理查询。

上述优化会在中心侧引入受 `HGW_RUNTIME_ASSET_CACHE_MAX_BYTES` 约束的远端插件缓存内存占用，并依赖 PostgreSQL `LISTEN` 健康状态来跳过冗余轮询与同步；当 `LISTEN` 断开时，监听器会立即回退至快速轮询和显式同步。

## 验证

单元测试覆盖转发连接池、动态压缩、远端资源缓存、访问修订透传、转发态 `node_content` 准入、单句终端与模型凭据快路径以及 Admin SPA 原地切电脑（`gateway/tests/http-compression.spec.ts`、`runtime-assets.spec.ts`、`node-service.spec.ts`、`proxy.spec.ts`、`instances.spec.ts`、`access-invalidation-poll.spec.ts`、`forwarded-principal.spec.ts`、`terminal-authorize-fast-path.spec.ts`、`model-first-token-fast-path.spec.ts`、`runtime-api.spec.ts` 与 `gateway/admin-ui/src/computer-switch.spec.tsx`）。端到端模拟延迟通过 `node --import tsx/esm gateway/tests/multi-computer-latency.perf.ts` 复现。依赖实时 PostgreSQL 的集成测试在缺少 `HGW_TEST_DATABASE_URL` 时自动跳过，由 CI 覆盖。
