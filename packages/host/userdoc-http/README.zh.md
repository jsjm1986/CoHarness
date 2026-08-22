# @deepseek-ai/dsh-host-userdoc-http

[English](README.md) | 中文

[`ctx.userDocs`](../../attachment/userdoc/README.zh.md) 的流式浏览器 HTTP Consumer。它通过 Host Connection 注册 `/api/documents`，因此请求会先经过既有的 Host／Origin 信任检查，而上传字节不会进入 Connection 的缓冲 JSON bridge。

`GET /api/documents` 返回部署限额和递归文档视图；加上 `?directory=<directoryId>` 则返回一个文件夹的直接子项。`GET /api/documents/directories` 返回可用移动目标。`POST`、`PATCH` 与 `DELETE /api/documents/folders` 分别创建、重命名和删除空文件夹，`POST /api/documents/move` 在不替换已占用目标的前提下移动一个文档。

`POST /api/documents?name=<filename>&directory=<directoryId>` 把原始请求体流式写入所选文件夹，并要求 `x-dsh-document-upload: 1`；即使在 Connection 的同源检查之前，该自定义头也能阻止跨源 simple request 提交请求体。`GET` 或 `HEAD /api/documents/content?id=<docId>` 以 `nosniff` 和附件 disposition 流式下载。`DELETE /api/documents?id=<docId>` 幂等删除文档。响应只公开稳定的 `UserDocError.code`，绝不包含文档字节或失败的绝对路径。

## 模型体验

无，因为该包只存储和传输文件；另一个会话 Consumer 决定哪些文档内容进入模型请求。

#### KV 缓存影响

无；该包既不装配也不发送提供方请求。

## 已知限制与待完成工作

- **自身不提供认证** —— route 继承 Connection 的可达性与同源策略；把 Web server 暴露到回环之外的部署必须在网关提供认证。
- **没有服务端分页** —— 递归和直接子项列表都返回完整当前结果；浏览器在本地对返回的文档分页。
- **下载只使用附件模式** —— 内联预览需要按格式隔离内容的独立 viewer。
