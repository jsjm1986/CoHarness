# Agent Note: DeepSeek 请求扩展逐字段容错并约束字节上限

Status: implemented

[English](2026-10-12-deepseek-request-extension-resilience.md) | 中文

## 问题

所有已注册的 DeepSeek 请求扩展此前与最弱的贡献者同命运：任一 provider 的 `prepare()` 异常会让整个模型请求失败；贡献者在 HTTP 2xx 之后的 `accept()` 失败会在流已经成功的情况下仍上报为请求失败；而反复失败会在每次请求重复记录警告。另一方面，`dsh_session_log` 会把完整的待传会话日志后缀无界地序列化进一个字段，长会话或含附件的会话可能让每个路由请求超过 provider 上限；跨会话格式代际的水位错配还可能让上传在外来代际的游标上静默续传。

## 决定

把上游 `0aed8de976d`、`7facb1cf65d`、`193f9ce4130` 移植到 CoHarness 的 `deepseek-llm-api-extensions`、`llm-deepseek` 与 `session-log-deepseek`：

- 注册表独立准备每个 provider。抛错或不可克隆的结果只从该请求中省略对应字段，每个字段只告警一次，取消仍是唯一的整体拒绝路径。
- 适配器把 `accept()` 推迟到 HTTP 2xx 之后，接受失败通过 `onExtensionsUnaccepted` 上报而非抛出；宿主注册为降级重放、被省略路由与未接受路由警告各做一次去重。
- `session-log-deepseek` 新增 `maxBytes` 字段（默认 8 MiB，仅正整数），以 UTF-8 字节约束完整的 `dsh_session_log` 序列化贡献。每个请求发送能装进上限的最长待传事件前缀；已接受水位跨请求排空积压，第一条事件单独超限就省略字段并按阻塞事件告警一次。接受记录与 wire envelope 均携带 `sessionFormatVersion`；其他代际或版本畸形的记录会在 fold 处被忽略或拒绝。

CoHarness 在移植行为之前保留自有门禁：`enabled` 默认 `false`，端点白名单与 `COHARNESS_DISABLE_SESSION_LOG_UPLOAD` 熔断开关仍然抑制交付，审计日志不变。

## 备选方案

**任一扩展出错就拒绝整个请求。** 否决：可选贡献者不能拖垮所有路由模型调用，这正是本修改修复的上游缺陷。

**在请求内截断事件而非按前缀。** 否决：接受水位只沿连续前缀推进，任意截断要么跳过序列，要么复杂化重放契约。

**保持 `enabled` 非 volatile。** 否决：上游把它改为 volatile，让设置写入无需重载即可作用于下一次请求；保持同形让移植忠实，同时保留我们默认关闭的姿态。

## 影响

损坏或超大的扩展只会让单个字段降级，不再拖垮请求。长会话把单次上传约束在 `maxBytes` 以内，并跨连续的已接受请求排空。缺 `sessionFormatVersion` 的旧接受记录读作 v0，在当前代际会话上被跳过，从而做一次保守的全量重发，而不是使用损坏的游标。

## 验证

`packages/llm/deepseek-llm-api-extensions/tests/registry.spec.ts` 与 `packages/llm/llm-deepseek/tests/extensions.spec.ts` 覆盖 provider 失败、取消、单次告警、流不失败的接受失败与序列化回退（17 个测试）。`packages/session/session-log-deepseek/tests/upload.spec.ts` 覆盖默认与精确字节上限、UTF-8 计量、经接受水位排空积压、首事件超限单次告警，以及格式版本畸形拒绝（34 个测试）。两个包 typecheck 干净。

## 相关

- [RC2 行为对齐](../architecture/2026-08-22-rc2-behavior-alignment.zh.md)——以上游发布行为为兼容基准、同时保留 CoHarness 产品门禁的既定规则。
- 上游提交：`0aed8de976d`（逐字段故障隔离）、`7facb1cf65d`（警告去重）、`193f9ce4130`（`maxBytes` 约束）。
