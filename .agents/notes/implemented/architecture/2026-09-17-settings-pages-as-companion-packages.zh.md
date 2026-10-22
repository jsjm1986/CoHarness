# Agent Note：设置页作为伴生包

状态：已实现

[English](2026-09-17-settings-pages-as-companion-packages.md) | 中文

## 问题

四个官方设置页——终端、Agent 循环、Subagent、网页搜索——都放在一个客户端包 `ui-settings-plugins` 里，与「内置插件」分区挨着。每新增一个内置页面都让这个包再长一截，而想要设置页的社区组合包也找不到"页面与拥有命名空间的插件放在一起"的现成样板。曾考虑把每个页面搬进注册其命名空间的宿主包，但行不通：shell 命名空间由执行器家族在 sandbox 行之下注册，循环包为了一个数字字段要长出浏览器构建，Subagent 的命名空间从子路径行注册，而子路径行不携带浏览器半侧。

## 决策

**社区插件的设置页放在自己包的浏览器半侧。** 它注册进 `plugins.bundle.config` 或 `plugins.row.config`，自己拥有文案和样式，通过 `ctx.settingsScope` 读写。它的 i18n 走客户端 locale 服务，已发布的社区组合包本来就是这么做的。

**自带的内置卡片放在 `ui-settings-plugins`。**[单一入口改动](../simplification/2026-10-09-plugins-page-single-entry.zh.md)把伴生包收回一个包，[patch 行绑定](../feature/2026-10-23-plugins-item-patch-row-binding.zh.md)把每个 `plugins.item` 条目的键定为其功能运行所在的行。宿主包不含浏览器代码；卡片编辑的命名空间以字面量拼写，从不从 owner 导入。

**表单机制搬进 `ui-primitives`。** `SettingsFormModel` 及 `settingsNumberField`、`settingsTextField`，`SettingsValueField` 与 `SettingsSecretField`，以及 `SettingsForm` 框架，是每个页面共同渲染用的套件；框架以 `labels` 接收文案，模型接受结构化的 scope，因此基线包既不依赖任何插件也不依赖其字典。

**`settingsScope.whileServed(namespaces, register)` 仍是服务层按已服务命名空间为门的规则。** 服务监视共享的 describe 镜像，命名空间出现时执行注册，一个都不再服务时注销。自带卡片不再使用它——它们按上述 patch 行绑定无条件注册。

**`ui-settings-plugins` 拥有自带的内置卡片：** 六个以各自 patch 行为键的 `plugins.item` 条目，见上述绑定 note。

## 考虑过的替代方案

**由 schema 驱动的通用表单。** 否决：通用渲染器只覆盖标量字段，碰到第一个动态控件就止步——Subagent 页的实时模型目录、跨字段规则、一次 mutate 提交——而每个例外都会变成一个 schema 本不该承担的 role。每个页面都是代码；没有发页面的社区插件就没有页面。

**内置页面做成双面宿主包。** 因上述原因否决；伴生包给能带半侧的包留了这个选项。

**表单框架的文案放在一本共享字典里。** 否决：那会让每个页面耦合到另一个插件的字典键；每个页面的字典自带那几条框架文案。

## 后果

- 插件页按声明顺序列出来自一个包的内置功能卡片；绑定卡片的开关与改名后的分组使页面 golden 随之更新。
- 手册[添加设置页](../../../../docs/cookbook/adding-a-settings-card.zh.md)展示社区路径并点名伴生包模板。
- 客户端模块系统的规则不变：浏览器半侧挂在说明符为裸包名的 Loader 行上，因此拆成子路径行的组合包，其注册的所有页面都留在根行上。
- shell 功能在 `plugins.item` 里的 id 是 `bash-sandbox` 与 `pwsh-sandbox`——patch 行而非 settings 命名空间：官方页面上的 `subject.id` 是 `plugins.detail.*` 贡献据以判断的标识，所以 id 命名卡片所切换的行。

## 测试

`ui-settings-plugins` 的 `tests/apply.client.spec.ts` 钉住六次以 patch 行为键的无条件注册并在 teardown 时收拢全部贡献；card 与 controller 用例承载每个页面的行为。`ui-primitives` 中的 settings-form 用例钉住套件，`ui-settings` 中的 while-served 用例钉住自带卡片不再使用的服务规则。`apps/web/tests/plugin-config.e2e.ts` 走真实链路验证终端页与 Subagent 页。
