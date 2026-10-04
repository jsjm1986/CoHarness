# Agent Note: 接通 Admin 插件面的英文词典

Status: implemented

[English](2026-10-04-admin-plugins-bilingual-dict.md) | 中文

## 问题

Admin 插件面在设计上是双语的——`locales.ts` 持有一份完整 `en` 词典，其键集对照 `zh` 事实源做类型检查，`components.spec.tsx` 两种词典都驱动——但生产到处钉死 `zh`：`PluginsPage` 用 `zh` 构造翻译位，`resolveLocalized` 返回 `text.zh ?? text.en`，且 `PluginsPage`、`PluginMatrix`、`PluginConfiguration` 携带约百条词典之外的内联中文。`OrganizationModelsEditor` 同样钉死共享 models 插件的 `zh` 文案。`en` 词典是没有消费方的死代码。

## 决策

一个持久化语言缝：`src/language.ts` 的 `adminLanguage()` 读取 `coharness-admin-language` localStorage 项，默认中文；侧栏脚的选择器写入选择并刷新。插件面全部字面量收进 `locales.ts` 键——页面框架、目标授权、草稿栏、生命周期行、矩阵状态/表格/手动添加行、配置面板的约束/凭据/归属文案——`satisfies Record<PluginManagerLocaleKey, string>` 在编译期强制英文对齐。`resolveLocalized` 与 schema `meta.description` 带语言参数、以另一语言兜底；`translatePlugin(language)` 是唯一的翻译位工厂；`OrganizationModelsEditor` 持 `organizationCopyEn` 对照 `organizationCopyZh` 覆盖。没有词典的页面（用户、项目及其余 admin 标签，以及 `ResourcePermissions` 等共享件）在英文下保持中文——边界是词典本身，而非半截改写。

## 文件

- `gateway/admin-ui/src/language.ts` — `AdminLanguage`、`adminLanguage()`、`setAdminLanguage()`（容忍存储拒绝）。
- `gateway/admin-ui/src/plugins/locales.ts` — `zh`/`en` 各约 90 个新键。
- `gateway/admin-ui/src/plugins/presentation.ts` — `translatePlugin(language)`；`resolveLocalized(text, language)`。
- `gateway/admin-ui/src/plugins/{composition,PluginMatrix,PluginConfiguration}.ts(x)` — 语言接入元数据标题与全部文案。
- `gateway/admin-ui/src/pages/PluginsPage.tsx` — 页面文案走 `t`；`SETTINGS_OWNER_KEYS` 取代字面标签表。
- `gateway/admin-ui/src/components/OrganizationModelsEditor.tsx` — en/zh 文案选择。
- `gateway/admin-ui/src/App.tsx` — 侧栏脚 `LanguageSelect`。
- `gateway/admin-ui/src/language.spec.ts` — 缝、插值与兜底覆盖。

## 考虑过的替代方案

**默认取 `navigator.language`。** 语言是管理员显式选择的偏好，且规格语料钉死中文为默认；按浏览器语言默认会让共用机器困惑，也会让非英文环境下的全部 zh 断言翻转。

**在内联字面量之上叠翻译层。** 约一百条字面量活在词典之外，键位对齐永远不可能成为编译期性质；提取进 `locales.ts` 后，`satisfies Record<PluginManagerLocaleKey, string>` 成为今后每个新键的守卫。

**本次顺带本地化所有 admin 页面。** 词典即边界：没有词典的页面保持中文，好过交付半成品翻译；页面提取是后续工作，不在此处做半截改写。

## 后果

设置该偏好后，插件页与组织模型编辑器渲染英文；其余面在设计边界内保持中文，待其自有词典落地。翻译位按组件记忆一次——语言切换随刷新生效，与持久化偏好契约一致。
