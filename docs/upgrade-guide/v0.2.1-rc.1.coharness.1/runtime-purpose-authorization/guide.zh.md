---
kind: upgrade-guide
description: "归档和文档管理断言拒绝其声明用途之外的 HTTP 操作。"
---

# 将 Gateway 专用断言限定到其声明的操作

[English](guide.md) | 中文

## 变更

`archive-read` 断言仅接受 `GET /api/internal/archive/read`。`document-admin` 断言仅接受 `POST /api/documents/trash`、`POST /api/documents/restore` 和 `DELETE /api/documents/purge`。此前，运行时认证会将这些断言放行到无关 HTTP 端点，由各处理器决定访问权限。超出声明方法和路径的请求现在会在派发前收到 HTTP 401，即使断言中的用户是管理员。

Gateway 的私有运行时 API 会以 HTTP 403 拒绝受限用途的断言，除非端点明确允许该用途。受限断言不能调用跨作用域复制回调。文档生命周期的目录端点保留对 `document-admin` 的显式许可。

## 迁移

1. 同时升级 Gateway 和 `dsh-gateway-runtime`，并重启托管运行时。现有 Gateway 归档读取器和文档生命周期代理已经使用允许的路由。
2. 更新将这些断言复用于无关操作的自定义调用方。交互请求需要自己的已认证用户断言；专用断言只能用于[文档列出的操作](../../../../packages/context/gateway-runtime/README.zh.md#runtime-contract)。
3. 确认归档导出和管理员文档恢复仍可使用。将任一专用断言复用于文档上传或会话操作，确认收到 HTTP 401 且没有数据变更。无需迁移文档、数据库或会话日志。
