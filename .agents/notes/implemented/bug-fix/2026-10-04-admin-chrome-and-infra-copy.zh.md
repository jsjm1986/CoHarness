# Agent Note: 管理外壳与插件基础设施文案接入语言缝

Status: implemented

[English](2026-10-04-admin-chrome-and-infra-copy.md) | 中文

## 问题

插件面词典与持久化的 `adminLanguage()` 语言缝只覆盖插件页。管理外壳本身——侧栏导航、品牌副标题、语言选择器、登出、移动端「更多」对话框、`LoadingState`/`Dialog`/`ConfirmDialog` 共享件的默认文案——全部硬编码中文，英文偏好下仍渲染中文框架包裹本地化页面。插件基础设施层在页面之下也有同样问题：`transport.ts` 的报文完整性失败、`composition.ts` 的应用/保存提示、`settings-store.ts` 的失效/不一致错误都内联中文字面量，完全绕过词典。

## 决策

通用词典对——`language.ts` 中的 `CopyPair<K>` 与 `translateCopy(language, { zh, en })`——把词典形态从插件词典中析出，任何面都能得到同样的编译期 zh/en 键位对齐：`zh` 仍是键源，`en` 满足 `Record<Key, string>`，`{name}` 占位符经翻译位插值。`chrome.copy.ts` 承载外壳词典，由 `App.tsx` 与 `components/ui.tsx` 共享件消费。基础设施错误移入 `plugins/locales.ts` 键位（`wire*`、`composition*`、`settings*`），因为它们经插件面的错误/通知管道渲染；`transport.ts` 与 `settings-store.ts` 在使用点解析翻译位，与切换即重载的偏好契约一致。

## 文件

- `gateway/admin-ui/src/language.ts` — `CopyPair<K>`、`CopyTranslate<K>`、带 `{name}` 插值的 `translateCopy(language, pair)`。
- `gateway/admin-ui/src/chrome.copy.ts` — 导航、品牌、选择器、登出、对话框关闭、加载、取消词典。
- `gateway/admin-ui/src/App.tsx` — 导航标签按 `ChromeCopyKey` 键化，选择器/登出/更多对话框/回退文案走翻译位。
- `gateway/admin-ui/src/components/ui.tsx` — `LoadingState` 默认值、对话框关闭标签、确认框取消走外壳词典。
- `gateway/admin-ui/src/plugins/locales.ts` — 双语的 `wire*`/`composition*`/`settings*` 错误键。
- `gateway/admin-ui/src/plugins/{transport,composition,settings-store}.ts(x)` — 所有抛出或上抛的消息经 `translatePlugin(adminLanguage())` 解析。

## 影响

英文偏好下外壳与插件管理错误通道均渲染英文；各页面正文在后续词典提取落地前保持中文。`translateCopy` 是新面词典的唯一翻译位工厂——新文案文件必须以 `zh` 为键源，使键位对齐保持编译期性质。
