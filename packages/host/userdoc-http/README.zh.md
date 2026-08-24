# @deepseek-ai/dsh-host-userdoc-http

[English](README.md) | 中文

[`ctx.userDocs`](../../attachment/userdoc/README.zh.md) 的流式浏览器 HTTP Consumer。它通过 Host Connection 注册 `/api/documents`，因此请求会先经过既有的 Host／Origin 信任检查，而上传字节不会进入 Connection 的缓冲 JSON bridge。

`GET /api/documents` 返回部署限额和递归文档视图；加上 `?directory=<directoryId>` 则返回一个文件夹的直接子项。`GET /api/documents/directories` 返回可用移动目标。`POST`、`PATCH` 与 `DELETE /api/documents/folders` 分别创建、重命名和删除空文件夹，`POST /api/documents/move` 在不替换已占用目标的前提下移动一个文档。

`POST /api/documents?name=<filename>&directory=<directoryId>` 把原始请求体流式写入所选文件夹，并要求 `x-dsh-document-upload: 1`；即使在 Connection 的同源检查之前，该自定义头也能阻止跨源 simple request 提交请求体。默认存储接受传输层和文件系统支持的所有文档大小；显式设置有限的 `maxFileBytes` 时，HTTP 会同时检查 `Content-Length` 和流式接收的字节。`GET` 或 `HEAD /api/documents/content?id=<docId>` 以 `nosniff` 和附件 disposition 流式下载。`DELETE /api/documents?id=<docId>` 幂等删除文档。响应只公开稳定的 `UserDocError.code`，绝不包含文档字节或失败的绝对路径。

`POST /api/documents/transfer` 是带版本号的 Gateway 快照复制操作。请求声明任意个人或项目源、目标及文档 id；支持项目到项目和管理员多目标分发。项目读取要求成员身份，写入要求 `rw`（组织管理员隐式拥有 `rw`）。Gateway 把源响应直接流式写入目标运行时上传端点，沿用目标命名策略，返回逐文件安全元数据，并在元数据目录和审计轨迹中保存溯源信息。浏览器不会收到源字节或绝对路径。没有 `gatewayRuntime` 的 standalone composition 返回 `DOCUMENT_TRANSFER_UNAVAILABLE`。

`GET /api/documents/transfer/capabilities` 只返回当前安全作用域名称和可写目标，不会列出或打开任何文档。

`POST /api/documents/transfer/list` 接受一个已授权的源作用域，并为 composer 选择器返回安全文档元数据；不会返回路径或文件字节。

在 Gateway 部署中，浏览器请求会先由 Gateway 文档 broker 接管，再进入运行时代理。Standalone composition 仍直接使用 Host Consumer；两条路径都不会在浏览器响应中暴露运行时回环地址。

`POST /api/documents/transfer/directories` 返回安全的目标文件夹元数据，`POST /api/documents/transfer/directories/create` 在检查目标 `rw` 后创建文件夹。`GET /api/documents/overview` 返回用户可读的全部作用域元数据，`GET /api/documents/history` 返回当前作用域最近的审计操作。

`POST /api/documents/transfer/plan` 执行只读元数据预检并返回五分钟有效的计划令牌；`/commit` 和 `/retry` 在开始流式复制前重新校验源和目标权限，成功与失败文件分别提交。

## 模型体验

无，因为该包只存储和传输文件；另一个会话 Consumer 决定哪些文档内容进入模型请求。

#### KV 缓存影响

无；该包既不装配也不发送提供方请求。

## 已知限制与待完成工作

- **自身不提供认证** —— route 继承 Connection 的可达性与同源策略；把 Web server 暴露到回环之外的部署必须在网关提供认证。
- **没有服务端分页** —— 递归和直接子项列表都返回完整当前结果；浏览器在本地对返回的文档分页。
- **下载只使用附件模式** —— 内联预览需要按格式隔离内容的独立 viewer。
