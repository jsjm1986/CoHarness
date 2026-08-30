# Agent Note: Let client language packs extend the locale catalog

Status: implemented

[English](2026-08-30-extensible-client-locale.md) | 中文

## 问题

locale 服务虽然接受任意标签的字典，却只暴露内置的 `zh` 和 `en` 选项。插件无法增加可选择的语言，已保存但尚未加载的语言偏好也无法恢复，否则只能把未知值当作当前语言。

## 决策

`LocaleRuntime.addLanguage` 注册经过校验的 ASCII BCP 47 风格 id、名称和已注册的 fallback。查找与持久化对大小写不敏感，定义按注册顺序发布，并返回幂等 disposer。fallback 链必须终止于 English；未知目标和循环在注册时失败。字典注册接受同样归一化的标签，定义和字典可以任意顺序到达。浏览器匹配先检查完整标签再检查主子标签；已保存的外部偏好在定义出现前保持暂定，不会成为当前语言。移除当前定义后回到最新的浏览器／默认语言，并通过 LocaleFace 订阅更新语言行和 `<html lang>`。

## 考虑过的替代方案

**把选择器限制为 `zh` 与 `en`。** 不采用：第三方 UI 插件将被迫 fork locale 服务或自带选择器。

**让未知保存 id 直接成为当前语言并等待字典出现。** 不采用：界面会显示没有定义或 fallback 的语言，还可能持久化不可用状态。

**允许任意 fallback 图。** 不采用：循环和缺失 fallback 会让逐 key 查找不确定，并可能使缺失文案无法结束。

## 影响

语言包可以用普通 Cordis effect 挂载和卸载，同时保持内置字典的类型化契约不变。Host settings 现在校验任意格式正确的语言标签，因此外部偏好可以跨 reload 保留。复数、脚本特定格式化和双向布局仍由语言包负责。

## 测试

locale 测试覆盖注册／卸载、大小写归一化、延迟字典、递归 fallback、错误标签、保存的外部偏好、浏览器选择，以及原有 Host 写入和只读行为。
