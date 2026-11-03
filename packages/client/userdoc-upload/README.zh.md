---
description: "English | 中文"
kind: "package-reference"
---

# @deepseek-ai/dsh-client-userdoc-upload

[English](README.md) | 中文

供对话 composer 和文档管理器共用的浏览器上传器。它通过有大小上限的 XHR 分片发送 `resumable-v1` 文档协议，计算每个分片和最终文件的 SHA-256，自动重试暂时性网络错误，并保存不透明会话元数据，使用户刷新页面后重新选择同一文件即可继续。

本包没有 Cordis service 或 UI 表面。各 Host 客户端提供相对路由、JSON 请求 helper 和网络错误适配器；上传器只在浏览器中处理文件字节，并在 IndexedDB（失败时使用 localStorage）中只保存不透明的会话元数据，不保存文档字节。元数据在服务端报告的会话过期后删除（旧记录使用七天兜底期限），每个浏览器存储后端最多保留 256 条记录和 1 MiB。

已接受的校验使用独立的五分钟浏览器等待预算。接收阶段的过期时间戳不会结束该等待；完成或失败由服务端状态决定。

适配器可以为每个协议请求追加稳定的 query，并提供恢复命名空间。命名空间会参与浏览器恢复键，因此同一个文件在不同个人或项目文档作用域中拥有独立的可续传会话。

完成响应必须包含有效文档引用，其字节数和完成进度必须与所选文件一致。无效响应通过宿主现有的响应错误适配器报告，不会报告成功或丢弃恢复元数据。可选文档身份字段会经过校验并保留，未知身份字段被省略。

## 概述

使用 `dsh-client-userdoc-upload` 作为会话创作区与文档管理器共用的浏览器上传器。它以有界 XHR 分块执行 `resumable-v1` 协议、计算 SHA-256 摘要、重试瞬时失败，并保存不透明的会话元数据，使中断的上传在页面刷新后可续传——文件字节除上传本身外不离开浏览器。

## 目录

- [模型体验](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

## 模型体验

没有直接影响；浏览器侧文档传输库只搬运文件字节，不注册任何模型可见内容。

#### KV Cache 影响

无；本包从不组装或发送提供方请求。

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

- **一次调用只处理一个文件**：多文件顺序、取消和界面状态由 Host UI 负责；本包刻意让每个选中文件拥有独立的可恢复状态机。
- **浏览器存储是尽力而为**：隐私模式或受限配额的浏览器可能丢失有界的会话元数据；服务端会把接收中会话保留到过期，并把已接受的校验保留到结束，但用户需要重新选择文件，不能直接使用本地会话 id。
- **认证和路由可用性由 Host 适配器负责**：上传器只使用消费方提供的回调，不负责刷新凭据或发现文档服务不可用。


<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>

<a id="model-experience"></a>
