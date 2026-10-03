# Agent Note：组织模型设置写入经 describe mirror 折叠

状态：已实现

[English](2026-10-04-org-model-settings-revision-fold.md) | 中文

## 问题

管理端组织模型编辑器在 REST facade 上建了 `SettingsDescribeMirror`，却从未把写答案经 `acceptView` 折叠，而组织设置与凭据写入共享同一个服务端 `model_configuration_revision`。每次 mutate 或凭据写入成功后，镜像里的 `namespace.revision` 保持陈旧，下一次带 `expectedRevision` 的写入必然自我冲突 409，直到编辑器重挂载——不需要任何并发。另外，共享 Provider 编辑器允许把组织 Provider 的 `models` 清空（org 校验器拒绝 `models: []`），行级 `PUT /admin/api/model-providers` 接收 `profile` 字段却静默丢弃，Usage 配额对话框缺少详情页对成本微额已有的 safe-integer 校验。

## 决定

`createOrganizationModelsMirror` 返回 `{ describeFace, api }` 对：mutate 答案经 `acceptView` 折叠返回的命名空间，`settings-conflict` 答案触发 `describeFace.load()` 使重试带上真实修订号，凭据 set/unset 同样触发 load——它们推动共享修订号却不返回视图。共享 `ProviderEditor` 在 `credentialScope: 'organization'` 下把显式拥有的空 `models` 数组视为阻止提交的失败（`providerModelsRequired`），指引用户改用删除 Provider。行级 model-providers 路由显式拒绝 `profile`——profile 只经 `/admin/api/model-settings` 写入，在此转发会使设置段与目录失同步。`UsagePage` 套用与详情页相同的 `Number.isSafeInteger(costMicros)` 校验。

## 文件

- `gateway/admin-ui/src/model-settings-api.ts` — `createOrganizationModelsMirror` 折叠写答案并在凭据写入与冲突时刷新。
- `gateway/admin-ui/src/components/OrganizationModelsEditor.tsx` — 消费该镜像/facade 对。
- `packages/client/ui-settings-models/src/client/ProviderEditor.tsx` 与 `locales.ts` — 组织作用域下显式空 `models` 阻止提交。
- `gateway/src/admin-api.ts` — 行级路由拒绝 `profile` 并指向 `/admin/api/model-settings`。
- `gateway/admin-ui/src/api.ts` — `ModelProviderInput` 去掉被静默忽略的 `profile` 成员。
- `gateway/admin-ui/src/pages/UsagePage.tsx` — 成本微额 safe-integer 校验。

## 影响

包在 describe mirror 外的 REST facade 必须折叠每一个可能推动共享修订号的写答案，包括不返回视图的凭据写入。端点无法兑现的字段在路由处拒绝，不得静默丢弃。
