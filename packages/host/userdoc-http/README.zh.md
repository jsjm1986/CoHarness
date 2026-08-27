# @deepseek-ai/dsh-host-userdoc-http

[English](README.md) | 中文

[`ctx.userDocs`](../../attachment/userdoc/README.zh.md) 的流式浏览器 HTTP Consumer。它通过 Host Connection 注册 `/api/documents`，因此请求会先经过既有的 Host／Origin 信任检查，而上传字节不会进入 Connection 的缓冲 JSON bridge。

`GET /api/documents` 返回部署限额和递归文档视图；加上 `?directory=<directoryId>` 则返回一个文件夹的直接子项。提供 `limit`、`cursor`、`q`、`type` 或 `sort` 时返回带不透明延续游标的有界元数据页。`GET /api/documents/directories` 返回可用移动目标。`POST`、`PATCH` 与 `DELETE /api/documents/folders` 分别创建、重命名和删除空文件夹，`POST /api/documents/move` 在不替换已占用目标的前提下移动一个文档。`/api/documents/trash` 列出或将文档移入回收站，`/api/documents/restore` 恢复一个文档，`DELETE /api/documents/purge` 永久删除一个文档；所有浏览器引用都会把主机路径替换为空路径字段。

上传使用版本化可续传会话协议：`POST /api/documents/uploads` 创建或复用会话，`PUT /api/documents/uploads/<uploadId>/chunks/<index>` 接收带 SHA-256 的原始 `Content-Range` 分片，`POST /api/documents/uploads/<uploadId>/complete` 启动最终校验，`GET` 查询进度，`DELETE` 取消会话。每个分片都小于公网入口限制，因此不再依赖单个请求承载整个文件。已移除的单请求 `POST /api/documents` 返回 `426 UPLOAD_PROTOCOL_REQUIRED`。`GET` 或 `HEAD /api/documents/content?id=<docId>` 以 `nosniff` 和附件 disposition 流式下载。`DELETE /api/documents?id=<docId>` 会幂等地把文档移入可恢复回收站；`DELETE /api/documents/purge?id=<docId>` 永久清理已在回收站中的文档。响应只公开稳定的 `UserDocError.code`，绝不包含文档字节或失败的绝对路径。

`POST /api/documents/transfer` 是带版本号的 Gateway 快照复制操作。请求声明任意个人或项目源、目标及文档 id；支持项目到项目和管理员多目标分发。项目读取要求成员身份，写入要求 `rw`（组织管理员隐式拥有 `rw`）。Gateway 把源响应直接流式写入目标运行时上传端点，沿用目标命名策略，返回逐文件安全元数据，并在元数据目录和审计轨迹中保存溯源信息。浏览器不会收到源字节或绝对路径。runtime JSON 元数据响应会先经过 8 MiB 字节上限再校验，活动的合并列表读取为每个等待方独立处理取消。没有 `gatewayRuntime` 的 standalone composition 返回 `DOCUMENT_TRANSFER_UNAVAILABLE`。

`GET /api/documents/transfer/capabilities` 只返回当前安全作用域名称和可写目标，不会列出或打开任何文档。

`POST /api/documents/transfer/list` 接受一个已授权的源作用域，并为 composer 选择器返回安全文档元数据；不会返回路径或文件字节。

在 Gateway 部署中，Gateway 还负责 `/api/documents/transfer/uploads` 及其可续传子路由。每个请求通过经过校验的 `scope` query 指定个人或项目目标，Gateway 会在把请求流式转发到目标运行时前重新检查写权限。Standalone composition 仍然只提供当前运行时上传路由。

在 Gateway 部署中，浏览器请求会先由 Gateway 文档 broker 接管，再进入运行时代理。Standalone composition 仍直接使用 Host Consumer；两条路径都不会在浏览器响应中暴露运行时回环地址。

`POST /api/documents/transfer/directories` 返回安全的目标文件夹元数据，`POST /api/documents/transfer/directories/create` 在检查目标 `rw` 后创建文件夹。`/api/documents/scope` 子树会对其他作用域的列表、内容、文件夹、移动、回收、恢复和永久清理请求应用相同授权。`GET /api/documents/overview` 返回用户可读的全部作用域元数据，`GET /api/documents/history` 返回当前作用域最近的审计操作。

Gateway 的 `document-admin` principal 只被回收、恢复和永久清理路由接受；普通文档读写仍要求运行时用户拥有对应作用域权限。

`POST /api/documents/transfer/plan` 执行只读元数据预检并返回五分钟有效的计划令牌；`/commit` 和 `/retry` 在开始流式复制前重新校验源和目标权限，成功与失败文件分别提交。

## 模型体验

无，因为该包只存储和传输文件；另一个会话 Consumer 决定哪些文档内容进入模型请求。

#### KV 缓存影响

无；该包既不装配也不发送提供方请求。

## 已知限制与待完成工作

- **自身不提供认证** —— route 继承 Connection 的可达性与同源策略；把 Web server 暴露到回环之外的部署必须在网关提供认证。
- **旧的当前运行时列表未建立索引** —— 提供方可能为了完整响应扫描整个根目录；Gateway 的作用域列表对大型工作区使用有界分页。
- **下载默认使用附件 disposition** —— `inline=1` 只对图片、PDF 和文本媒体生效，并为预览 viewer 附带严格的内容策略。
- **临时上传会话有保留期限，已发布文档没有自动过期** —— 未完成会话按本地后端策略清理，已完成文档仍需用户删除。
