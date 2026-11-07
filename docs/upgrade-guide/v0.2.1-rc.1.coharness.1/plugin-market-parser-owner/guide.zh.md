---
kind: upgrade-guide
description: "插件市场解析拒绝进程准入等待期间发生变化的资源提供者。"
---

# 资源提供者替换后重试市场搜索

[English](guide.md) | 中文

## 变更

插件市场在进程准入前保留解析器的资源提供者。等待期间提供者被移除或替换时，以 `plugin-market/fetch-failed` 拒绝，其原因是 `ResourceAdmissionError` 的 `unavailable`。未使用的许可在转移响应体或创建 Worker 前归还原提供者。此前，解析器可能使用过期许可启动，并缓存得到的索引。

已经运行的解析器保留现有终止和记账责任。配置、索引格式和成功的市场结果保持兼容。

## 迁移

1. 部署匹配的 `@deepseek-ai/dsh-plugin-market` `lib/index.js` 和 `lib/worker.cjs` 产物。保留[托管资源启动步骤](../managed-resource-admission/guide.zh.md)。
2. 搜索被拒绝后恢复准入，并重新搜索。不要将旧许可转移给替代提供者。
3. 确认准入期间替换提供者不会启动解析线程，且新搜索成功。参见[市场参考](../../../../packages/boot/plugin-market/README.zh.md)。
