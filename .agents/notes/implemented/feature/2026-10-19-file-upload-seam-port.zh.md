# Agent Note: file-upload 接缝移植

Status: implemented

[English](2026-10-19-file-upload-seam-port.md) | 中文

## Problem

上游 `dsh-v0.2.1-rc.2` 附带 `packages/client/file-upload`：一套临时 Session 级上传面（Host HTTP 接收 → 内容寻址 attachment → `agent:fileUploads/upload` 回执 → prompt 引用 → `file` block）。fork 此前将其延期，因为 `attachment/userdoc` + `host/userdoc-http` + `client/userdoc-upload` 已覆盖持久化可断点续传的文档上传——属于不同模型——导致除 composer 之外的消费者缺失这条通用接缝。

## Decision

接缝移植落在 [`packages/client/file-upload`](../../../../packages/client/file-upload/README.zh.md)，含两处 fork 适配；composer 保持走 userdoc 路径。

- **HTTP 传输**：上游通过 `connection.fetch.register` 注册 Fetch 处理器；fork 的 host 传输是 Node `req`/`res` 上的 `ctx.connection.http.handlePrefix`，因此 `http-route.ts` 消费请求流并通过 Node API 在同一个 `uploadFileBinary` 前缀写回状态码、响应头与响应体。
- **冷 Session 解析**：上游通过 `registerAgentResolver` 钩子解析上传目标 Agent；fork 通过可选的 `sessionController` 服务经 `ctx.get('sessionController')` 解析——服务缺失即该 Session 不可上传，与其他 remote 面冷加载 Session 的方式一致。

服务保留上游语义：上传是绑定单个 Session 的一次性、不可续传回执；进入 prompt 的准入仍是 commands 层的职责。它不取代 userdoc——`userdoc` 上传是带 SHA-256 分块续传的持久文档——`ui-conversation` 的 composer 继续通过 `createDraftDocuments` 路由非图片文件选择。

## Alternatives considered

- **把 composer 改接到 `ctx.fileUpload.upload`** 被否决：这会复活此前为采用 userdoc 而移除的重复选择路径，给用户两条外观相同但语义不同的上传行为。
- **保持接缝不移植** 因 API 对齐理由被否决：`agent:fileUploads/upload` 属于已发布客户端面，composer 之外的消费者——SDK 调用方与未来插件——可能依赖它。

## Testing

`tests/file-upload.client.spec.ts` 与 `tests/file-upload-http.host.spec.ts` 覆盖回执暂存、HTTP 接收的成功与失败路径（超限请求体、未知 Session），以及生成的 Typert 产物。`apps/web/tests/file-upload-round.e2e.ts` 按 fork 的 composer 恢复了上游浏览器场景：它驱动文档栏与图片栏（上游的单一待发送附件栏与暂存回执发送门在此不存在），断言 userdoc 准入——渲染文本加 `source.documents` 与 `userdoc/attached`（而非 `file` block）——并依据 `snapshots/web/file-upload-round/session.v7.jsonl` 通过真实的 `read` 工具读取已存副本。

## Consequences

两种上传模型刻意共存；调用方须按场景选择。`cordis.patch.yml` 将该包装进 web 组合，`scripts/upstream-sync.json` 将其归类为 `adapted`。未来需要临时回执的消费者——自动化、无持久存储的插件——可直接使用 `ctx.fileUploads`，无需改动 composer。
