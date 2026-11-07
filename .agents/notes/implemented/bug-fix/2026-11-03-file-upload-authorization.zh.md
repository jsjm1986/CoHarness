# Agent Note：文件上传要求会话权限与有效的所属对象

Status: implemented

[English](2026-11-03-file-upload-authorization.md) | 中文

## 问题

二进制上传使用 Connection HTTP 子树，不执行普通 Remote 的会话授权。浏览器鉴权本身不能授予私有或只读会话的写权限。上传也可能在所属服务结束后仍继续运行，或在字节仍在到达时失去被空闲回收的 Agent。

## 决策

[Host 服务](../../../../packages/client/file-upload/src/index.ts) 为两种传输捕获原始协作 provider 和参与者。在冷会话查找和存储前授权写入，并在发布凭据前再次检查同一 provider、调用方、确切 Agent 和当前权限。必需的 provider 消失不能降级为独立访问。拒绝使用既有的 `collaboration-forbidden` 结果。

已接纳的存储持有永久删除预约和确切 Agent 的空闲回收否决。这两者保护不同的生命周期操作：仅有删除预约无法阻止空闲回收。组合 effect 保留否决，直到服务取消和已接纳的存储结束。取消会关闭 Node HTTP 输入；自定义可迭代对象的生产者负责结束其待定读取。取消或最终授权失败后，已提交的不可变字节可以保留，但不生成暂存凭据。

## 考虑过的替代方案

**只在 Remote gateway 执行授权。** 二进制 HTTP 路由和直接 Host 消费方不经过该 gateway。

**只检查一次，或在存储后重新捕获身份。** 上传期间权限可能改变，重新捕获也可能把另一位参与者替换为原始调用方。

**请求取消时立即释放 Agent。** 存储清理可能仍在进行；这项工作结束前，准入仍保持关闭。

## 影响

原始与编码上传共享同一授权规则。独立本地应用保留既有上传行为。插件卸载移除路由和命令解析器，拒绝保留的上传引用，并等待已接纳的存储结束。已接纳 prompt 的凭据绑定和回滚仍可用于清理。

## 验证

真实 Loader [示例](../../../../packages/client/file-upload/tests/fixtures/managed-authorization.mjs) 使用 Gateway 签名身份、PostgreSQL 权限、真实 Agent 和本地不可变存储。它验证所属用户成功、私有与只读拒绝、流式传输中撤权、调用方取消、服务卸载、临时文件移除和空闲保护。单元覆盖检查排队时 provider 改变、确切 Agent 替换、保留的服务引用，以及真实命令注册表中的凭据绑定。
