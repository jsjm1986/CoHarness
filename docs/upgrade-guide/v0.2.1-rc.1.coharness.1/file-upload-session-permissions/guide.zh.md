---
kind: upgrade-guide
description: "受管文件上传调用方必须在凭据发布前保持会话写授权有效。"
---

# 文件上传会话权限

[English](guide.md) | 中文

## 变更

二进制 `POST /api/session/uploadFileBinary` 上传此前通过浏览器鉴权，但未执行编码 Remote 所要求的会话写检查。现在两个入口都在上传服务内部执行这项检查，包括在冷会话查找前和凭据发布前检查。私有、只读和失效授权返回既有的 `collaboration-forbidden` 错误。二进制响应保留 HTTP200 结果封装，使用 `ok: false`。

取消、服务卸载或接收 Agent 被替换后，不发布凭据。活跃存储阻止 Agent 自动空闲回收和永久删除，直至操作结束。取消时关闭 Node HTTP 输入；自定义可迭代对象的生产者必须结束其待定读取。已经提交的不可变字节可以在没有凭据的情况下保留。

## 迁移

1. 使用声明的 `@deepseek-ai/dsh-collaboration` 依赖重新构建 `@deepseek-ai/dsh-client-file-upload`，并一同部署两项定义。受管 Gateway 组合保留必需的协作 provider。
2. 仅对原始账号有权写入的会话发送上传。处理既有的结构化拒绝结果；授权恢复后使用新请求重试。只有独立应用才能通过不加载受管协作来保留独立本地行为。
3. 保持程序化源读取可取消。确认授权上传返回可用的同会话凭据，私有和只读上传被拒绝，未完成的上传无法触发 Agent 空闲回收。
