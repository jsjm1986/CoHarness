---
kind: upgrade-guide
description: "受管文档 SQLite 第 4 版及原生文件系统 UUID 要求匹配的 Gateway 与原生包。"
---

# 在重新挂载后保留受管文档身份

[English](guide.md) | 中文

## 变更

Gateway 受管文档元数据使用 SQLite 第 4 版和私有域标记第 2 版。可写打开会迁移第 2、3 版；不可变备份验证仍保持只读。macOS 在原目录 inode 之外，保存从描述符取得的文件系统 UUID。卷与目录不变时，可以归一化设备号，不替换文档实例、创建者、回收动作、待完成变更或投递游标。复制数据及变化的卷要求经过验证的恢复。没有持久 UUID 的主机保留严格的设备号与 inode 校验。

旧存储没有持久卷证据。在取得 UUID 前设备号发生变化，仍会明确拒绝；仅 inode 相等不能授权自动迁移。旧工作进程不能读取第 4 版。Session JSONL 格式及公开文档引用保持不变。

## 迁移

1. 停止 Gateway 文档写入方和运行时。一并保留当前各作用域的公开文档、私有元数据、保留文件和未完成上传。已验证备份保持不可变，已退役作用域独立保留。
2. 一起升级 Gateway、`@deepseek-ai/dsh-userdoc-local` 以及匹配的 `@deepseek-ai/node-addon-system` JavaScript 与原生载荷。原生操作要求 0.1.4 或更新版本；保持正确的平台及 libc 选择。匹配文件齐备后再启动 Gateway。
3. 旧设备号被拒绝时，继续停止写入方。所有存储位置均能提供持久文件系统 UUID 时，已授权的离线操作员可针对当前活动作用域调用 `recoverDocumentIdentityMount(locations, { databasePath, entries })`。`databasePath` 必须指向重新挂载前已独立验证的部署备份内的原元数据成员；`entries` 必须保留该快照原有的绝对路径清单、对象证据、大小、修改时间和 SHA-256 摘要。当前所有可恢复版本必须仍然匹配。该恢复保留后续永久删除历史及部分上传。缺失 UUID 或证据，或当前版本发生变化时，要求完整的兼容恢复；不得手工改写设备号、降低 SQLite 版本或移除私有标记。
4. 恢复成功后启动新的受管运行时。确认文档实例、创建者、保留回收项及所属部分上传进度在重启后保持不变。其他账号仍须无法继续别人的上传。中断后保持作用域不可用，并使用同一份独立证据重试。参见[提供方的恢复规则](../../../../packages/attachment/userdoc-local/README.zh.md)。
