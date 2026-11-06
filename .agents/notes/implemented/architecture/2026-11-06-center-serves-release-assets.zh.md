# Agent Note: The center serves release-bundled web assets from its own release files

Status: implemented

[English](2026-11-06-center-serves-release-assets.md) | 中文

## Problem

网关上每一个 `/assets/*` 与 `/plugins/*` 请求都会被钉到某个 Runtime —— 依据 Referer 追加 `?dshRuntime=<id>` 的 `302` —— 然后代理到所属节点，包括远程节点。Vite 产出的文件名带内容哈希，同一 release 在每台机器上的字节完全相同，但每个 Runtime 的 URL 都让浏览器缓存各建一份键，数 MB 的 bundle 还要走过整条链路上最慢的一段。跨多个 Runtime 工作的浏览器会把同一份不可变 bundle 每个 Runtime 各下载一次。

## Decision

center 改为从自己的 release 副本直接应答 release 自带的静态文件，不再挑选 Runtime。[release-assets.ts](../../../../gateway/src/release-assets.ts) 解析构建产物 `dist` —— workspace 与受管 release 布局下的 `apps/web/dist`，或固定安装时经运行时入口的 `dsh-web-app` → `dsh-web-frontend` 依赖链 —— 即 Runtime 端 `frontend-static` 服务的同一批文件。`ReleaseAssets.serve` 仅当解码后的路径仍在 dist 根内且命中真实文件时，应答 `/assets/*` 与 `/favicon.svg` 的 `GET`/`HEAD`；其余情况返回 `false`，请求原样落回既有的 Referer 钉选与代理路径。

该服务位于 [server.ts](../../../../gateway/src/server.ts) 的认证之后、Runtime 选择之前，因此未钉选的 URL、带 `?dshRuntime=` 的 URL、以及由 Referer 派生的 URL 都读到 center 的字节 —— URL 不再携带 Runtime 身份，这正是让一条浏览器缓存项跨所有 Runtime 复用的前提。访问控制不变：会话门控仍然先行，未认证请求仍然得到 401。

缓存语义按文件区分。basename 带有 Vite 的 `-<8+ 位哈希>.<扩展名>` 标记的文件是按内容寻址的，得到 `private, max-age=31536000, immutable`；其他文件 —— `favicon.svg`、未哈希的名字 —— 不带 `cache-control` 下发，与 Runtime 端 `frontend-static` 对非内容寻址文件的行为一致。`private` 保留：字节仍属各账户私有，只有浏览器在跨 Runtime URL 间共享，任何 CDN 或共享缓存都不得存储。`br`/`gzip` 变体镜像 `packages/host/webserver` 的 `precompressed.ts`（quality 9 / level 1、首次读取后台调度、仅记录已落定变体并以 identity 兜底、`vary: accept-encoding`），因为 Runtime 路径会对同一份字节压缩，center 不得回退传输体积。

保持 Runtime 作用域的是所有跨 Runtime 并不逐字节相同的内容。全部 `/plugins/*` 维持现有路径：combo 与 `client.*.js` chunk 由各 Runtime 按其组装状态合成，Runtime 安装的插件没有可供服务的 release 文件，`/plugins/events` 是必须到达其所属 Runtime 的实时 HMR 通道。这些 URL 仍由 Referer 钉选重定向（`302` + `?dshRuntime=`），可共享的插件 URL 也仍在 Referer 的 Runtime 下静默转发。release 自带但 center 的 dist 中不存在的名字 —— 包括路径穿越尝试 —— 走同一条回退路径。

## Alternatives considered

**让可共享 URL 在 Referer 的 Runtime 下继续静默转发。** 对 `/assets/*` 否决：它去掉了可见重定向，却仍把不可变字节代理穿过所属节点，远程 Runtime 的 bundle 依旧要过慢链路，本地缓存共享还取决于哪个 Runtime 先服务。从 center 自己的 release 文件应答把这一跳彻底移除。

**以同样方式去掉 `/plugins/*` 的 Runtime 身份。** 推迟：chunk 与 combo 由 Runtime 的模块注册表按其组装状态合成，center 要复现同样的字节就得再实现一遍该流水线。内容哈希修订号（同属本次改动）让以后可行；此处采用的 release 文件存在性判断无法分类合成响应。

**对共享 bundle 使用 `public` 缓存。** 否决：这些是经认证的字节，任务要求保留 private 姿态 —— 收益来自 URL 去掉 Runtime 身份，这已经让浏览器跨 Runtime 复用一条缓存项，无需把负载开放给共享缓存。

## Consequences

浏览器在任意多个 Runtime 上加载同一 release，每份带哈希的 bundle 只下载一次，且无论本地还是远程 Runtime 都不再位于资源路径上。首次命中的成本是每个文件一次 stat 加一次读取，Brotli/gzip 变体按文件代在 libuv 线程池上各构建一次。凡是 release dist 未命中的请求（安装的插件、events、缺失的名字、非 GET 方法）与今天的行为逐字节一致。这条回退同时约束了正确性：没有构建产物 dist 的部署会原样保留 Referer 钉选转发。

## Testing

`gateway/tests/release-assets.spec.ts` 端到端覆盖路由决策：带哈希与嵌套资源以 `private` immutable 缓存与精确字节下发，`favicon.svg` 与未哈希名字不带缓存头，钉选与 Referer 派生的 URL 不经目录或代理即应答，缺失文件/路径穿越/`POST`/`/plugins/combo.js` 落回 Runtime 路径，`/plugins/events` 仍然 302 钉选，未认证请求仍然 401。`node-service.spec.ts` 保留既有契约：release-assets 装配缺席时，可共享 URL 仍转发到 Referer 的 Runtime。
