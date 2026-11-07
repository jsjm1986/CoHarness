---
kind: upgrade-guide
description: "交接提取新增旧读取器不认识的必读 Session 事件。"
---

# 读取已记录的交接模型输入

[English](guide.md) | 中文

## 变更

辅助 `session_handoff` 提取在模型流开始前，通过仅日志可见的 `session/handoff-llm-request` 事件记录源 Session、请求的提供方／模型及完整输入消息。不认识这个必读事件的旧构建会拒绝受影响日志。当前读取器保留既有事件支持。Session 头部版本与结构格式不变，不重写任何已提交代次。

## 迁移

1. 从同一源码树重建并部署匹配的 Runtime、Gateway、Web 与归档读取器，包含生成的 Session 事件词汇及查询工具包。请将输入记录与匹配读取器一同交付。
2. 确认新交接日志含有 `session/handoff-llm-request`，且可由匹配读取器打开。TypeScript 与 Python 的无密钥交接 SDK 夹具验证物理派发顺序及落盘读回。不要为使用旧读取器而删除事件或覆盖已提交代次。
