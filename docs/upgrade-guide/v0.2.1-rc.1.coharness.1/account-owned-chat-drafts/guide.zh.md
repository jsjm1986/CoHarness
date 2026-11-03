---
kind: upgrade-guide
description: "Gateway 聊天草稿要求账号归属，不会恢复没有归属证明的浏览器记录。"
---

# Gateway 聊天草稿归属于已验证账号

[English](guide.md) | 中文

## 变更

Gateway 聊天草稿按账号、运行时和 Session 归属存储，不再仅使用 Session id。现有的 `dsh.conversation.chat.<Session>` 浏览器记录没有账号来源证明，不会恢复到 Gateway 账号中；这些记录仍保留在浏览器存储中。明确声明不要求 Gateway 授权的独立 Host 保留本地存储键。

各标签页保留归属记录的 session storage 副本，恢复时优先于共用持久副本。新标签页从已有归属记录初始化副本；刷新一页时可独立保留自己的文字。空间导航会将图片、文档引用和无法安全恢复的输入保留在原标签页，并提供在新标签页打开目标的操作。自定义 `SessionInputResolver` 实现必须提供 `hasUnsavedDrafts()`，覆盖其保留的全部输入。

自定义 `IConversation` 实现还需提供 `canAttachDocument(sessionId)`。文档管理器在向固定目标对话复制前调用它，并在接收时重新检查；授权插件可通过 `conversation/document-admission` 返回 `deny` 拒绝。没有对话时仍可明确执行文档复制。Gateway 目录调用方可用 `ids` 解析保存的 Runtime ID，既有游标与字节限制继续生效。

自定义框架呈现方需向 `shell.mobile.header.context` 提供 `compact`。`ComputerControl` 读取会话选择器，使名称跟随选中对话的 Runtime；缺失位置不会回退到另一 Runtime。没有详情或操作的 `ComputerBadge` 是纯文本展示。需要菜单的调用方应明确提供详情或操作，环境导航放在空间选择器中。

## 迁移

1. 升级前，从每个受影响的 Gateway 浏览器配置中复制或发送你自己的未发送草稿。能够访问共享会话，不代表拥有其他成员尚未发送的输入。
2. 升级后，登录同一个 Gateway 账号，打开对应会话，粘贴仍然需要的已保存文字。新记录在该来源的本地存储中使用 `dsh.conversation.chat.scoped.v1.` 前缀。无需迁移 Session 日志或数据库。
3. 刷新会话，确认能恢复自己的草稿。如果与其他账号共用浏览器，确认另一账号打开时显示其自己的草稿。参见[会话持久化参考](../../../../packages/client/ui-conversation/README.zh.md)。
