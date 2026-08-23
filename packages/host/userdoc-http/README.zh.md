# @deepseek-ai/dsh-host-userdoc-http

[English](README.md) | 中文

[`ctx.userDocs`](../../attachment/userdoc/README.zh.md) 的流式浏览器 HTTP Consumer。它通过 Host Connection 注册 `/api/documents`，因此请求会先经过既有的 Host／Origin 信任检查，而上传字节不会进入 Connection 的缓冲 JSON bridge。

`GET /api/documents` 返回部署限额和递归文档视图；加上 `?directory=<directoryId>` 则返回一个文件夹的直接子项。`GET /api/documents/directories` 返回可用移动目标。`POST`、`PATCH` 与 `DELETE /api/documents/folders` 分别创建、重命名和删除空文件夹，`POST /api/documents/move` 在不替换已占用目标的前提下移动一个文档。

`POST /api/documents?name=<filename>&directory=<directoryId>` 把原始请求体流式写入所选文件夹，并要求 `x-dsh-document-upload: 1`；即使在 Connection 的同源检查之前，该自定义头也能阻止跨源 simple request 提交请求体。默认存储接受传输层和文件系统支持的所有文档大小；显式设置有限的 `maxFileBytes` 时，HTTP 会同时检查 `Content-Length` 和流式接收的字节。`GET` 或 `HEAD /api/documents/content?id=<docId>` 以 `nosniff` 和附件 disposition 流式下载。`DELETE /api/documents?id=<docId>` 幂等删除文档。响应只公开稳定的 `UserDocError.code`，绝不包含文档字节或失败的绝对路径。

`POST /api/documents/transfer` 是带版本号的 Gateway 快照复制操作。请求声明个人或项目源、目标及文档 id；只支持个人到项目和项目到个人。当前运行时必须是其中一个端点，项目读取要求成员身份，写入要求 `rw` 成员。Gateway 把源响应直接流式写入目标运行时上传端点，沿用目标命名策略，返回逐文件安全元数据，并在 transfer 审计事件中保存溯源信息。浏览器不会收到源字节或绝对路径。没有 `gatewayRuntime` 的 standalone composition 返回 `DOCUMENT_TRANSFER_UNAVAILABLE`。

`GET /api/documents/transfer/capabilities` 只返回当前安全作用域名称和可写目标，不会列出或打开任何文档。

`POST /api/documents/transfer/list` 接受一个已授权的源作用域，并为 composer 选择器返回安全文档元数据；不会返回路径或文件字节。

## 模型体验

无，因为该包只存储和传输文件；另一个会话 Consumer 决定哪些文档内容进入模型请求。

#### KV 缓存影响

无；该包既不装配也不发送提供方请求。

## 已知限制与待完成工作

- **自身不提供认证** —— route 继承 Connection 的可达性与同源策略；把 Web server 暴露到回环之外的部署必须在网关提供认证。
- **没有服务端分页** —— 递归和直接子项列表都返回完整当前结果；浏览器在本地对返回的文档分页。
- **下载只使用附件模式** —— 内联预览需要按格式隔离内容的独立 viewer。
