---
description: "记录存储提供者所有的本地文件与专用数据目录，供部署备份选择并验证。"
kind: "package-library"
---

# @deepseek-ai/dsh-managed-data

[English](README.md) | 中文

## 概述

存储提供者使用此库，在写入前记录其实际所有的文件和专用数据目录。Gateway 备份收集结合这些记录、数据库确认的运行时身份，以及节点管理员的批准。`registerManagedDataPath()` 追加持久声明；`readManagedDataPaths()` 读取当前及之前的声明。登记保存归属元数据，不包含文件正文，也不授予权限。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与暂缓事项](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## 使用本包

向 `registerManagedDataPath()` 传入实际解析后的文件或专用数据目录路径、所属包，以及绝对路径的清单文件名。调用者显式提供目标；没有目标文件时不执行登记。Gateway 管理的启动通过 `DSH_MANAGED_DATA_MANIFEST` 提供目标。应在创建或修改提供者数据之前调用登记。清单格式错误或不可读取时拒绝该操作，不替换原始字节。

记录采用只追加的 JSONL，包含 `version: 1`、`owner`、`kind`（`file` 或 `directory`）和绝对 `path`。`readManagedDataPaths()` 保留配置变更前的旧根，并对重复声明去重。相同登记不会追加记录。备份读取时，缺少清单属于错误，不能证明运行时为空。准确的调用接口见[源码](src/index.ts)。

部署消费者必须核验运行时身份、停止写者、排除项目源码与 SSH 工作区、拒绝越界链接，并验证复制后的字节。单独登记从不授权删除源数据。

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节</summary>

文件描述符身份核验会拒绝验证与访问之间被替换的文件。即使清单并发增长，读取仍保持有界；16 MiB 限制适用于归属元数据，不限制应用文件。格式错误、不完整、过大和符号链接清单都会失败。成功登记前会刷盘文件，并在 POSIX 系统刷盘目录。

**运行时不变量：** 不发布伴随插件。此库在每次读取时验证持久记录；数据与生命周期由提供者负责，清单路径可以合法地先于文件创建。

</details>

<a id="further-exploration"></a>
## 进一步探索

- [Gateway 维护与恢复](../../../gateway/README.zh.md)定义获准根选择、历史采纳及完整备份验证。
- [部署维护决定](../../../.agents/notes/implemented/architecture/2026-09-25-gateway-deployment-maintenance.zh.md)记录写者互斥和恢复规则。

<a id="model-experience"></a>
## 模型体验

无，因为清单记录属于部署元数据，不进入模型请求或 Session 转录。

#### KV 缓存影响

不直接影响模型请求前缀。

## 已知限制与暂缓事项

<a id="known-limitations-and-deferred-work"></a>

- 清单只包含已经声明的存储。第三方提供者必须先登记数据路径，才能声称备份覆盖。
- 清单不遍历 SSH 文件系统，也不管理外部程序的缓存。部署批准和数据传输仍由消费者负责。
