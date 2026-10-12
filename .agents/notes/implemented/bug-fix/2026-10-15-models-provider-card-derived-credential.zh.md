# Agent Note: provider-card 槽位的 `keyConfigured` 跟随页面将使用的引用

Status: implemented

[English](2026-10-15-models-provider-card-derived-credential.md) | 中文

## 问题

`settings.models.provider-card` 槽位的 `keyConfigured` 只来自 `ProviderRow.credential`——即 profile 具名 `apiKeyEnv` 的联接结果。休眠行或无引用行不指名任何引用，因此槽位对这类行永远报告 false——而这恰恰是该行自己的编辑器会解析出派生 `<ROUTE>_API_KEY`（或带作用域前缀的 `DSH_`/`DSH_PROJECT_<id>_` 变体）的行。新增提供方草稿于是可能对扩展槽位报告「未配置密钥」，而它自己的编辑器却显示该惯例凭据已配置。此外，直接渲染 `ModelsSection` 时不传 `renderSlot` 也能通过编译，在应有子槽位的地方静默什么都不挂载。

## 决策

store 的 credential describe 现在在一次批量调用中覆盖两类引用：每个具名 `apiKeyEnv`，以及每个无引用行按其目录条目自身声明的归属作用域派生的引用——`deriveKeyRef(provider, entry.management, entry.projectId)`。`external` 路由不欠本页凭据，不贡献引用；缺少 project id 的项目路由同样不贡献。联接把第二类发布为 `ProviderRow.derivedCredential`，仅在 profile 未指名引用时出现。`keyConfiguredOf` 选取与该行的编辑器解析出的同一引用——先具名、再派生——槽位、草稿与编辑器从此不会再各执一词。`ModelsSectionProps` 将 `renderSlot` 设为必需：渲染器在调用时本就绑定它，漏传的直接渲染会在编译期失败，而不是静默什么都不挂载。

## 考虑过的替代方案

**只描述具名引用。** 槽位就会在每一个休眠行和无引用行上永远与编辑器不一致——而这正是「新增提供方」流程所面向的行。

**在渲染时派生凭据。** 渲染处知道页面作用域，却无法发起线路请求；必须先由 store 描述某引用，组件才有状态可读，因此 describe 与联接都属于 load。

## 后果

credential describe 可能比以前多报若干引用——每个休眠行贡献其按作用域派生的引用——但仍是一次批量调用。profile 指名引用的行不受影响：`credential` 仍跟随 `apiKeyEnv`，缺失密钥点也仍只看具名事实。扩展槽位从此看到的就是页面自身依据的事实，无论已配置卡、setup 卡还是新增提供方卡。

## 验证

`store.client.spec.ts`——联接测试断言一次批量 describe 覆盖具名加按作用域派生的引用（external 不贡献），且休眠行暴露其已描述的 `derivedCredential`。`components.client.spec.tsx`——草稿槽位用例挂载真实联接、打开「新增提供方」卡片，断言槽位对派生 `<ROUTE>_API_KEY` 已配置的休眠路由报告 `keyConfigured: true`。组件与 provider-form 各 spec 中的直接渲染点均按必需的 `renderSlot` 编译。包内 264 项测试、client typecheck 与 lint 全部通过。

## 相关

- [Models 设置扩展槽位](../architecture/2026-08-30-models-settings-extension-slots.zh.md)——槽位契约笔记，其 `keyConfigured` 事实语义由本次变更就地更新。
