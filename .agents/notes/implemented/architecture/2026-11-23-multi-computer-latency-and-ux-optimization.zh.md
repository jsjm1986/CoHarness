# Agent Note: 多电脑转发、治理快路径与 Admin 无重载切换

Status: implemented

[English](2026-11-23-multi-computer-latency-and-ux-optimization.md) | 中文

## 问题

多电脑部署将浏览器访问远端电脑的流量经由中心 Gateway 转发，同时每台远端 Gateway 需要跨高延迟隧道访问中心 PostgreSQL 治理库。此前每条冷建服务流都会在远端触发一次跨隧道 `authorizeChannel` 查询，空闲池默认每节点仅 2 条且任何组织级失效都会清空全部节点的空闲池，`LISTEN` 健康态下节点仍每秒轮询数据库。浏览器 JSON 响应与远端 `/plugins/*` 资源包未经压缩与缓存直传，Web 终端交互写入落入完整代理准入和多语句 SQL 授权，冷启动 `/api/prepare/v1/*` 依赖固定两秒轮询，转发请求在双端重复执行 `monitor.synchronize()` 且转发态 `node_content` 项目读无法走 `readySession` 快路径，项目与 `node_content` 运行时的模型轮次在首字前要执行多轮串行治理查询及第二次状态往返，Admin 管理台切换电脑还会触发整页浏览器重载。

## 决策

电脑可见性检查只在同一个已应用的权限修订内共享查询。无关修订可以在较早的检查完成前启动新检查。电脑或组织的权限失效会阻止所有仍在途的受影响电脑的肯定结果。任一旧版工作台请求失败时，Gateway 取消另一个请求并返回可用的项目目录。

`gateway/src/node-service-http-pool.ts`、`gateway/src/node-service-proxy.ts`、`gateway/src/node-service-stream.ts`、`gateway/src/deployment-topology.ts`、`gateway/src/http-compression.ts` 与 `gateway/src/runtime-assets.ts` 中的转发与传输层在不放宽鉴权的前提下压缩隧道往返与传输体积。空闲 HTTP 连接池默认上限调整为 `httpMaxIdleConnections = 32` 与 `httpMaxIdlePerNode = 6`，节点服务 TCP 套接字两端禁用 Nagle（`noDelay: true`），用户或项目级失效保留空闲的节点连接，电脑或组织级失效清理受影响的连接，显式登出失效同步切断本地代理与转发中的远端节点服务连接，远端桥接身份校验采用带失效联动和单飞去重的本地缓存（`HGW_NODE_SERVICE_IDENTITY_CACHE_MS`，默认 `5000`），控制连接池的租约语句同时返回预备读取所需的受管主入口和权限修订号。目标 Gateway 确认该修订仍有效后为对应的回环桥接登记主入口。缺少该证明时，请求走常规授权。 `PostgresDeploymentTopology.assertNode()` 合并同一权限修订下的并发可见性检查，并在 `LISTEN` 在线时缓存最多 256 条、最长 5 秒的 `entry_node_visible` 通过结果。拓扑保存、电脑或组织级失效以及监听断开都会清除相应的缓存和在途检查，查询在途期间若发生无关权限修订推进则仅跳过缓存写入而不误报冲突，拒绝结果始终重新核查，目标端本机 `?dshNode=<local>` 管理与文档请求直接跳过代理层重复节点鉴权，每次借用连接都核验精确节点租约，主入口在放行委托读响应前核验权限和 Runtime 代次，`LISTEN` 健康态下权限失效轮询放宽至 `HGW_ACCESS_INVALIDATION_HEALTHY_POLL_MS`（默认 `15000`）并在监听断开时自动回退快速轮询。账户接口（包含 `/account/api/users`、`/account/api/document-locations`、`/account/api/documents/transfer/*` 与项目 SSH/模型发现接口，且 `/account/api/workbench/catalog` 将 `projectsForUser` 与 `workbenchCatalog` 并行执行）、管理台接口（`/admin/api/*`）以及远端转发的可压缩响应（含符合压缩条件且未声明长度的分块响应）均按需协商 Brotli 或 gzip 压缩，同时保留 `vary` 头、弱化变更后的 `etag` 并排除流式媒体类型。中心节点在严格完成单次请求 `qualify()` 与 `monitor.synchronizeTo()` 后按 `HGW_RUNTIME_ASSET_CACHE_MAX_BYTES`（默认 `33554432`）有界缓存远端不可变 `/plugins/*` 与哈希 `/assets/*` 响应体，按电脑、Runtime 代次、账号和空间隔离条目，权限变更时移除受影响的条目，并在 `GET /admin/api/performance` 与 Admin 部署页按需折叠面板中暴露转发、连接池与缓存统计计数。

远端准入、冷启动探测与跨节点扇出减少冗余隧道等待。`gateway/src/access-invalidation.ts` 维护实时修订并提供 `ensureAtLeast(revision)`，签名转发声明（`gateway/src/forwarded-principal.ts`）携带中心已核验的 `accessRevision`，远端 `LISTEN` 游标已应用所需修订时可跳过跨隧道 `synchronize()`。权限变更待应用时暂停使用本地修订快速准入，就绪检查仍能观察取消动作。`gateway/src/runtime-asset-admission.ts` 在重新核验签发密钥与修订的前提下，将转发态 `node_content` 项目读纳入 `readySession`。`gateway/src/instances.ts` 采用递增步进 `[50, 100, 150, 200, 300]` ms 探测新启动运行时，`gateway/src/proxy.ts` 在冷启动 `/api/prepare/v1/*` 上执行有界服务端短等（`HGW_RUNTIME_PREPARE_WAIT_MS`，默认 `1500`）并返回 `retry-after: 1`。Web 终端交互输入使用绑定存活连接的持久文本 WebSocket 通道（`/api/terminal/input`，经由 `packages/client/connection` 与 `packages/api/terminal-controller` 的 `ctx.connection.ws.handle(...)` 注册），按创建者隔离活跃连接，校验创建者身份（`verifyUpgradeCreator`），在权限撤销、过期或登出时即时关闭，具备客户端有界确认超时、有界指数退避重连，以及到 HTTP `/api/terminal/write` 与 `/api/terminal/resize` 的透明回退（HTTP 路径继续以 `interactive` 优先级进入 `readySession` 并由 `gateway/src/execution-identity.ts` 单条 CTE 授权）。新建终端冷打开将默认 shell 探测与 `environment`/`list` 并行发起，且 `SessionRuntimePool`（`packages/client/runtime/src/client/sessions/pool.ts`）在目标运行时连通时并行拉取 `workspace.list` 与 `session.list`，每次切电脑节省一轮远端往返。跨电脑文档总览（`gateway/src/browser-documents.ts`）并发度提升至 `6`，本机 `/account/api/node-document-overview` 子请求采用无会话行锁校验，并在 `LISTEN` 已追平时跳过中间进度帧上冗余的 `monitor.synchronize()`（完成帧仍显式同步），工作台的独立读请求并行执行，客户端与 Admin 管理台采用实例拥有的 `sessionStorage` 持久化项目展示缓存（`packages/client/runtime/src/client/project-display-cache.ts` 与 `gateway/admin-ui/src/project-display-cache.ts`）消除 `#id` 闪烁，同时保持实时权限复核并在 401/403 或登出时清理。Runtime 启动同时读取插件状态、准备目录权限与模型策略，等待两项操作结束后处理结果。准备成功后才写入插件配置，已应用版本绑定本次启动代次。离线恢复检查可以准备同样的文件，并保留已应用版本标记。

模型首字准入覆盖个人、项目与 `node_content` Runtime。`resolveRuntimeCredential` 在单条语句中读取当前 Runtime 权限、写入代次和托管凭据。模型凭据端点可以选择缓存中的项目坐标，个人执行准入仅选择个人坐标。立即获准的有范围模型请求携带预留后 `authorizeSession` 的确认结果（`x-hgw-resource-qualified-grant: 1`），排队请求可以携带变更游标。`node_content` 执行授权在一条治理语句内核验项目落盘位置、管家资格和成员关系，并锁定匹配的项目和落盘位置记录。`gateway/src/operation-timing.ts` 通过 `ResourceLease.operationId`、`ModelAttemptTiming.resourceOperationId` 以及 `enterOperationId`/`authorizeOperationId` 贯通跨日志时序关联。

每个 Admin 页面由同一个数据路由管理中心和电脑子路由。部署上下文与电脑目录在导航过程中保持挂载。电脑范围内的链接和请求以已生效的路由确定所属节点。切换成功后按新电脑重新加载页面状态。两种路由共用同一个导航保护，有未保存表单时保留当前编辑，并提供在新标签页打开目标的链接。Admin 部署页通过单次压缩接口 `GET /admin/api/deployment/overview` 聚合首屏读切片（`deployment`、`backups`、`tunnel`、`nodeConfiguration`、按需 `nodeConnection` 以及中心侧 `runtimeAllocationPolicy`/`nodeAccess`，遇到 `404` 自动回退逐项请求），并在后台标签页暂停隧道轮询。窗口 `focus` 与 `visibilitychange` 被动刷新增加 2 秒节流，而显式策略变更事件保持立即刷新。[生产部署手册](../../../../gateway/deploy/README.zh.md)记录了 HTTP/2、upstream keepalive、压缩、禁用响应缓冲、WebSocket 升级映射与多电脑 Gateway 调优参数。

转发 WebSocket 时，Gateway 从 HTTP 池借用已复核节点租约的连接。在单连接配额下也可完成升级，WebSocket 独占该连接直到关闭。终端输入按连接合并连续且尚未发送的尺寸变更，保留用户输入顺序。账号上下文一起读取项目成员关系和显示策略，目录查询次数与远端项目数量无关。当前节点接口从同一份已授权的部署修订读取转发范围和部署元数据。项目名称读取被拒后，目录清除受影响项目的缓存名称，管理员可以手动重试。

个人工作台按条目类型分别用一条 PostgreSQL 语句核对存储位置并读取有权访问的原目录分页。合并首屏还查询尚未记入发布目录的旧会话，所属 Gateway 可并发执行这三条查询。读取节点本地索引后，再次核验存储位置和权限。中心单凭治理库中的租约无法确认节点当前可达，因此仍将目录读取转发给所选电脑。

部署概览和独立备份列表由 PostgreSQL 直接读取备份元数据。浏览器根据清单是否存在来展示恢复操作。验证和恢复读取所选记录的完整清单。每份备份内的文件数量不影响概览响应的体积。

## 考虑过的替代方案

**仅以权限修订放行委托读。** 节点租约和 Runtime 代次可以独立变化。主入口返回响应前核验当前授权。

**在 `qualify()` 之前返回缓存的远端 `/plugins/*` 资源或不保留 `vary` 头。** 在请求准入前命中缓存会绕过按用户与节点的访问控制。坚持先完成 `qualify()` 与 `monitor.synchronizeTo()` 再读取缓存，确保每次命中都遵守实时权限与编码协商。

**让 Web 终端击键始终停留在逐次 HTTP POST 而不引入 WebSocket 输入通道。** 即使接入 `readySession` 与单句 CTE 授权，每次 HTTP 按键批次仍需穿越中心与远端准入网关和 PostgreSQL 校验。通过 `ctx.connection.ws` 将文本 WebSocket（`/api/terminal/input`）直接绑定到已认证的 `follow()` 连接，在保留精确创建者校验、权限撤销即时断开和透明 HTTP 回退的同时彻底消除单次击键的 HTTP 与数据库开销。

**切换电脑时按新路径前缀重建 Admin 路由。** 每台电脑使用单独路由时，浏览器可能在旧页面完成拦截前离开表单。补写历史条目会丢掉浏览器的前进记录。由同一个路由管理整个页面的历史，表单保护才能覆盖跨电脑导航。

## 结果

在可复现的多电脑基准（`gateway/tests/multi-computer-latency.perf.ts`，模拟远端隧道 PostgreSQL RTT 40 ms、中心 4 ms，按 ×5 折算 200 ms 生产隧道）中，6 并发首屏请求将远端跨隧道 `authorizeChannel` 由 6 次降至 1 次、远端 `accessSync` 由 6 次降至 0 次；10 次连续热态 `/api/terminal/write` 中位延迟下降约 60%（40 ms RTT 下约 150 ms 降至约 60 ms，对应 200 ms 隧道约 750 ms 降至约 300 ms）；无关用户失效不再触发重连（`poolOpened: 0`，突发延迟降约 70%）；双路 WebSocket 升级中位延迟下降约 72–79%；3 节点文档总览提速约 3 倍；远端 `/plugins/combo.js` 缓存热命中延迟下降约 75–86%，传输字节通过 `br` 减少 98.2%。个人终端授权由 11 条串行 SQL 压缩为 1 条，活跃态项目与 `node_content` 模型轮次消除了整轮状态 HTTP 往返及多次跨隧道治理查询。

上述优化会在中心侧引入受 `HGW_RUNTIME_ASSET_CACHE_MAX_BYTES` 约束的远端插件缓存内存占用，并依赖 PostgreSQL `LISTEN` 健康状态来跳过冗余轮询与同步；当 `LISTEN` 断开时，监听器会立即回退至快速轮询和显式同步。

## 验证

单元测试覆盖转发连接池、动态压缩、远端资源缓存、访问修订透传、转发态 `node_content` 准入、单句终端与模型凭据快路径、双向 WebSocket 终端输入通道、已核验项目展示缓存、按需 Admin 性能诊断以及 Admin SPA 原地切电脑（`gateway/tests/http-compression.spec.ts`、`runtime-assets.spec.ts`、`node-service.spec.ts`、`proxy.spec.ts`、`instances.spec.ts`、`access-invalidation-poll.spec.ts`、`forwarded-principal.spec.ts`、`terminal-authorize-fast-path.spec.ts`、`model-first-token-fast-path.spec.ts`、`runtime-api.spec.ts`、`packages/client/connection/tests/websocket-channel.host.spec.ts`、`packages/api/terminal-controller/tests/input-channel.spec.ts`、`packages/client/runtime/tests/project-display-cache.client.spec.ts`、`gateway/admin-ui/src/pages/PerformanceDiagnosticsSection.spec.tsx` 与 `gateway/admin-ui/src/computer-switch.spec.tsx`）。端到端模拟延迟通过 `node --import tsx/esm gateway/tests/multi-computer-latency.perf.ts` 复现。依赖实时 PostgreSQL 的集成测试在缺少 `HGW_TEST_DATABASE_URL` 时自动跳过，由 CI 覆盖。
