# Agent Note: 持久化路径安全修复——spill 发布、附件载体、V3 重启修复

Status: implemented

[English](2026-10-12-durable-path-safety-fixes.md) | 中文

## 问题

持久化输出路径上三个独立缺陷，均由上游源码比对确认：

1. `OutputCollector` 在独占 `openSync` 成功前就发布 `spillFile`，open 失败会让 `discardSpill` 删除本进程从未创建的路径（含被植入的 EEXIST 项）；抛错的 `onFailure` reporter 会以未捕获异常逃出流监听。
2. 实时附件路由（`api-proxy.ts` 的 `imageInEvent`）与导出收集器（`session-export.ts` 的 `collectEventAttachmentRefs`）对任意事件 payload 扫描 `content`/`message`/`inserted`/`stream` 字段，opaque 或可忽略插件事件可能触发附件存储读取。
3. CoHarness 的 V3→V4 阶段既不修复被打断的 turn，也不重映射 `image/offload` 目标 seq，V3 重启产出的 V4 日志缺 `turn/end`，offload 事件仍指向重编号前的坐标。

## 决定

1. 移植上游 `cafb9b93b4b`：`openSync` 成功后才发布 `spillFile`；抛错的 reporter 收敛为一行 stderr；所有者日志行由导出的 `logSpillFailure(logger, owner)` 共享，`subprocess-local` 与 SSH helper 复用。
2. 移植上游 `0c44e5461db`：只扫描声明的一方载体——`user/message`/`tool/ptc-dispatch` 的 `content`，`system|developer|tool/result|team/message/queued` 的 `message.content`，`agent/inbox/spliced` 的 `inserted[].content`，`compaction/summary` 的 `summary`/`rawOutput`，`assistant/message`/`assistant/attempt` 的已完成 `block-end` 流记录——另保留我们为无版本工件携带的 `assistant/chunk` 载体。两处都取消 `tool-result` 嵌套下探。
3. 把上游 `ad83cce36ac` 适配到 CoHarness 折叠阶段：`observeRestart` 在 `next-turn` inbox splice 之后出现非开步状态的 `turn + 1` `turn/start` 时合成 `turn/end` `{ reason: { kind: 'interrupted' } }`；`remapDataReferences` 增加经 `mappingNumber` 校验的 `image/offload` `targets[].seq` case。

## 备选方案

**保留任意 payload 扫描。** 否决：持久化插件事件是无边界输入面，附件读取有存储开销；上游修了同一缺陷。

**因 CoHarness 仅传递性迁移 v3 而跳过重启修复。** 否决：v3→v4 阶段仍是已发布 v3 工件的接纳点，缺 `turn/end` 在下游严格 V4 校验中失败，与上游记录一致。

## 影响

失败的 spill open 不再能删除外部路径；所有者 reporter 不再能拖垮收集。附件发现只读声明字段，无载体 case 的插件事件被整体忽略。V3 重启迁移为严格合法的 V4 日志并补 `interrupted` turn end，`image/offload` 坐标在插入边界后保持正确。原先经 `context/inserted` 或嵌套 `tool-result` 块解析附件的事件不再生效——这些形态从来不是声明载体。

## 验证

`subprocess-local` 359 测试（EEXIST 不删外部路径、抛错 reporter 被收敛、裸调用 stderr、所有者日志行）、`session-format-v3-to-v4` 43 测试（重启修复、拒绝矩阵、跨边界重映射、offload 校验）、`apiproxy` session-export 43 测试（声明载体被导出、opaque payload 原样保留）；四个包 typecheck 干净。

## 相关

- [DeepSeek 请求扩展容错](2026-10-12-deepseek-request-extension-resilience.zh.md)、[Python PTC 共享沙箱策略](2026-10-12-python-ptc-shared-sandbox-policy.zh.md)——同一 alpha.2 对齐行动。
- 上游提交：`cafb9b93b4b`、`0c44e5461db`、`ad83cce36ac`。
