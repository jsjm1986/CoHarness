# 使用 Web UI

[English](index.md) | 中文

请先按照[根目录 README](../../../README.zh.md#run) 中的说明启动 Web UI；命令会打印其访问地址。本指南从服务器已经运行的状态开始。`dsh` 进程会把启动时所在的目录作为默认文件系统位置；全新的 Web UI 则不会选中任何工作区，你需要添加一个工作区。

## 配置模型

打开**设置 → 模型**，输入 [DeepSeek API 密钥](https://platform.deepseek.com/)并保存。模型路由会立即可用，不需要重启服务器。

[模型配置指南](./providers.zh.md)介绍其他提供方和自定义 OpenAI 兼容端点。

## 选择工作区

点击**选择工作区**，添加启动 `dsh` 时所在的项目目录，然后选中它。选中工作区前，会话输入框不可用。

## 使用个人文档

打开**文档**可以在个人文档工作区上传和管理文件。个人文档与所选项目工作区相互独立。在个人会话中，可以直接询问 Agent（智能体）：“找到我的年度报告并总结。”`standard`、`code` 和 `cordis` preset 能按名称列出个人文档，并读取选中的文本文件，因此不需要再次把同一文件上传到聊天中。项目会话不会继承个人工作区；请附加文件，或使用明确共享的项目文档。

## 运行任务

启动一个会话并发送：

> Summarize this repository and identify its main packages.

Agent（智能体）可以读取和编辑工作区文件、运行命令、委派工作并维护计划。如果根据当前权限策略，某项操作需要审批，Web UI 会先询问你。

## 继续使用

- [配置模型](./providers.zh.md)
- [使用 Python SDK](./python-sdk.zh.md)
- [使用其他 CLI 模式](../../../apps/cli/README.zh.md)
- [开发插件](../develop/basic/index.zh.md)
