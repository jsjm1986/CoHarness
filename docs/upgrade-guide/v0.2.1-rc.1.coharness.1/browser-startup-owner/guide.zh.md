---
kind: upgrade-guide
description: "原生 Stagehand 启动在配置目录创建、准入和 Worker 就绪期间保留资源所有者。"
---

# 资源所有者变化后重新获取浏览器

[English](guide.md) | 中文

## 变更

原生 Stagehand 启动在异步配置目录创建、进程准入和 Worker 就绪期间，拒绝已撤回或替换的资源提供方以及新增的必需准入。未使用额度归还原提供方，完成报告失败时保留重试入口。此前这些等待可能在所有者变化后仍启动或发布连接。

取消关闭连接后，新 Worker 使用当前准入。已有的自有 Chromium 进程范围在确认终止前保留原额度。失败重连保留清理入口，另一连接等待清理成功，提供方关闭在释放占用前等待在途重连。此前失败重连的清理入口可能遗失。浏览器配置和 Session 数据保持兼容。

Worker 构造与不确定性报告同时失败时，保留两项原因和原报告以便重试。清理完成前，另一 Session 不能获取该附加浏览器。确认收到不确定性报告后，额度仍保持无法确认状态。

## 迁移

1. 重新构建并部署匹配的原生 Stagehand 主入口和 Worker 产物。
2. 恢复准入后，以新的浏览器操作重试被拒绝的启动。不要复用或转移旧额度。
3. 直接调用 `openBrowserWorker` 且保留可变化提供方的调用者，可以传入 `admission.assertOwnership`。`admission.budget` 为 undefined 时，在该检查下允许独立分配。直接调用 `launchChromium` 可以传入可选的第五个所有者检查参数。省略时保留传入的提供方。参见[提供方参考](../../../../packages/experimental/browser-use-stagehand-native/README.zh.md)。
4. 直接调用 Worker 的代码必须保留 `ResourceAcquisitionCleanupError.cleanup`，在记账恢复后重试；原报告未获确认期间不要丢弃其占用。
