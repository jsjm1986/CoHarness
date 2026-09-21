# @deepseek-ai/dsh-client-ui-permission-presets

[English](README.md) | 中文

面向两种不同生命周期的浏览器权限界面。「通用」设置行读取显式暴露的 `permission` Settings 描述符，从 host 的动态 `defaultPreset` enum 中推导选项，并携带描述符的 revision 写入一条 `settings.mutate` 路径操作。它的 observable 经 slot 系统的 `hooks` 格传递，因此 React 钩子由渲染器绑定；推送的失效通知会重新获取描述符。这个值仅在后续会话创建时生效；改变它不会切换当前会话。内置预设标签跟随当前 locale（`Read Only`、`Workspace Write`、`Full access` 的本地化版本）；部署自定义标签保持原文。选择 Full access 时必须先显式确认风险，该行随后才会写入。

当前会话界面仍是挂在 host `/permission` 命令上的 popupSelect **装饰**（`ctx.commandUi.decorate`）。装饰不是第二条命令——host 命令保留斜杠菜单行、带参路径（`/permission <preset>` 直接切换）与持久生命周期记账；装饰只把裸调用替换为选择框：一张扁平预设列表，当前值标记为 active，内置标签通过当前 locale 本地化，部署自定义标签使用 Title Case 回退。选中即提交 `/permission <preset>` 命令行。选项与 active 标记读取会话的 `permissions` 投影（与 composer chip 渲染的同一份 host 计算 select），因此两个当前会话界面共享同一读源与同一写路径，推送的投影帧是两者共同跟随的唯一确认。装饰恰在投影 key 存在时可用；无权限组合既不显示选择框，也不显示 Settings 行。

`/client` 导出面为插件本体（`apply`／`inject`）。

## 概述

为当前 Web 会话或未来会话选择权限预设。通用设置行只更改之后创建会话所用的默认值；composer 与 `/permission` 选择器切换当前会话。默认 Web 提供仅可查看、工作区内修改与完全权限。显式加载实验 Auto integration 后，当前会话选择器会增加带 `EXP` 标记的 Auto review。通过可见选项选择完全权限或 Auto 时，需要分别确认对应风险；完整的 `/permission <preset>` 命令直接执行。宿主通过 Session 投影确认每次变更。

## 模型体验

间接影响。它的两个界面写入权限事实：设置行使未来会话带着全量值旋钮事件启动，而 `/permission` 选择器追加选中的当前会话预设。沙箱与审批消费方各自解析自己的旋钮事件；选择 `auto` 还会启用宿主 Auto integration 的独立逐调用 reviewer。

#### KV Cache 影响

无直接失效；请求前缀的变化由旋钮消费方自行承担。

## 已知限制与暂缓事项

- **Settings 行仅在 Web 中可用**：非 Web 客户端仍可通过 `/permission` 切换当前会话，但不会获得这项浏览器贡献。
