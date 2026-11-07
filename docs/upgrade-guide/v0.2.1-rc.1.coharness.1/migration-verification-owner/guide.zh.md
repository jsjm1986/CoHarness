---
kind: upgrade-guide
description: "历史 Session 写入拒绝校验排队期间发生变化的资源提供者。"
---

# 资源提供者替换后重试迁移发布

[English](guide.md) | 中文

## 变更

JSONL 持久化校验器在本地排队和节点准入等待前保留资源提供者。创建 Worker 前，如果提供者被移除、替换，或原先独立的请求新增了准入，历史写入打开会以 `ResourceAdmissionError` 的 `unavailable` 原因拒绝，并将未使用的许可归还原提供者。此前，等待中的校验可能接管替代提供者，或使用过期许可启动。

已提交的历史代次保持完整，被拒绝的校验不会发布后继代次。已经运行的线程保留原有清理和记账责任。配置、Session 数据格式和成功读取保持兼容。

## 迁移

1. 部署匹配的 `@deepseek-ai/dsh-session-persistence-jsonl` `lib/index.js` 与 `lib/worker.cjs` 产物。保留[托管资源启动步骤](../managed-resource-admission/guide.zh.md)。
2. 等待历史写入打开完成。遇到 `unavailable` 后恢复准入并重新打开；不要将旧许可转移给其他提供者。
3. 确认提供者替换后排队请求不启动线程，且新请求成功而历史源字节不变。参见 [JSONL 参考](../../../../packages/session/session-persistence-jsonl/README.zh.md)。
