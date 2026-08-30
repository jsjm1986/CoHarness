# @deepseek-ai/dsh-client-locale

[English](README.md) | 中文

locale 插件：LocaleRuntime——偏好以 `locale.preference` 存储在 `$DSH_HOME/settings.yaml` 中；若没有显式 Host 值，全新浏览器会暂时使用 `navigator` 请求的第一个已注册语言（先匹配完整标签，再匹配主子标签；若都不匹配，则使用 `en`）。Host 读取在插件激活后执行，因此 settings 服务不可用不会阻塞页面；读取结果会实时替换浏览器暂定值。已保存但尚未注册定义的外部 locale 会等待该定义注册，不会在不可用时成为当前语言。经已认证 Gateway 提供服务的浏览器使用账户级 transport 保存认证成员的选择；只有账户路由明确不支持时才回退到 Host。`locale/change` 仅在切换语言时触发；插件会在激活时以及每次切换时把 `<html lang>` 指向外部语言 id 或内置语言的文档标签。该服务还拥有 ns×locale 字典注册表，实现 slot 系统的 `LocaleFace`，并经 `ctx.slots.installLocale` 自行安装，支撑框架注入的 `t` 标准席位（`Translate`／`TranslateNS` 是 ui-slots 的类型；请从那里导入——本包的再导出仅为字典所有者提供便利）。该持久化边界由[Host settings 支撑的偏好决策](../../../.agents/notes/implemented/bug-fix/2026-08-06-host-backed-web-preferences.zh.md)拥有。

本包只内置 `zh` 与 `en`。外部 client 插件通过 `ctx.effect(() => ctx.locale.addLanguage({ id, label, fallback }))` 增加可选语言，并通过 `register(ns, locale, dict)` 增加该语言的字典；定义与字典可以按任意顺序注册。定义卸载后会从选择器移除，正在使用的选择回落到当前可用的浏览器语言或默认语言。外部 id 是 ASCII BCP 47 风格标签。其 fallback 必须已注册，形成的链必须终止于 `en`；未知目标、重复 id 和循环会在注册时失败。每个 key 先在当前语言的命名空间沿链查找，再在 `common` 中重复该链，最后显示 key。类型化 `register(ns, { zh, en })` 形式仍按 `LocaleNamespaceMap` 检查。

## 语言包注册

语言包插件把语言定义和每个已翻译命名空间注册为自身拥有的 effect：

```js
export const inject = ['locale']

export function apply(ctx) {
  ctx.effect(
    () => ctx.locale.addLanguage({ id: 'ja', label: '日本語', fallback: 'en' }),
    'my-locale: language',
  )
  ctx.effect(
    () => ctx.locale.register('common', 'ja', { cancel: 'キャンセル' }),
    'my-locale: common dictionary',
  )
}
```

## 设置权限

Language 行跟随绑定的账户级 settings scope；首次视图仍在 loading、scope 不可用或提供方只读时，选择器会禁用。项目运行时不会接管账户偏好，认证成员的选择通过账户 transport 保存，只有账户路由明确不支持时才回退到 Host。`LocaleRuntime.setLocale` 也执行相同的可写视图检查，因此程序化调用无法绕过禁用行发起 mutation；写入失败时会从恢复后的值重新采用状态。

## 模型体验

无。locale 注册表为浏览器 UI 文案提供服务；这里没有任何内容进入模型请求。

#### KV Cache 影响

无；该包既不组装也不发送提供方请求。

## 已知限制与暂缓事项

- **部分界面仍保留内联文案**——设置行、侧边栏、问题作答器和模型选择使用 locale seat；其他包仍直接拥有静态文本。
- **注册表持有的文本只读取一次翻译**——在 slot 渲染路径之外于注册时捕获的文案（例如 command 注册表中的 `/model` 命令描述）在重新注册前保持注册时的语言；slot 渲染的文案随切换实时更新。
- **语言包负责语言特有行为**——注册表提供选择、持久化、浏览器匹配、逐 key 回退和 `<html lang>`；它不增加复数规则或双向布局。
