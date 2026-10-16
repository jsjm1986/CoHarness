# Agent Note: 可配置的正文、代码与终端字体

Status: implemented

[English](2026-10-17-configurable-font-settings.md) | 中文

## Problem

主题插件此前只持久化调色偏好：会话正文、代码块与侧栏终端都以固定字号渲染在内置字族栈上。上游将三个角色全部开放为可配置——各角色范围内的整数 px 字号，以及叠加在内置字族栈之前的逗号分隔字族列表——并附带该特性所需的设置界面、键盘控制、首屏应用与持久化。

## Decision

`ThemeSnapshot` 在 `preference` 之外携带 `fontSizes` 与 `fontFamilies`,`ui-theme` 设置段为每个角色增加一个字段——`fontSize`、`codeFontSize`、`terminalFontSize`、`textFontFamily`、`codeFontFamily`、`terminalFontFamily`。设置作用域仍是唯一写入通道:每个被接受的值都经 `host.set(field, value)` 在 `pendingWrites` 围栏内落盘，使一次较早写入的 Host 回显无法覆盖更新的乐观变更,`adopt()` 仅在持久值有差异时重新发布。

字族输入在服务边界一次性归一化：剥除不安全字符、为非通用名加引号、`''` 选择内置栈,因此每个落盘列表都可安全地内联进 CSS 与启动脚本。快照、设置行与 presenter 看到的都是同一份归一化列表。

设置界面是一个 `settings.general.item` 条目：正文字号行的展开按钮打开代码与终端字号行以及每角色一个字族输入框。快捷键目录在 `primary+=`/`primary+-` 上保留 `fontSize.increase`/`fontSize.decrease`(`primary+shift+=` 同样增大),仅桌面端,各角色在自身范围内一次调整并合并为一次快照发布;输入法合成、已被默认阻止、重复按键、终端区域与修饰键不匹配的输入均不被消费。

`ThemePresenter` 拥有六个 body 变量(`--dsh-content-font-size`、`--dsh-code-font-size`、`--dsh-terminal-font-size`、`--dsh-font-family-{text,code,terminal}`),在提交点写入或移除。Host 索引引导在 shell 挂载前把持久字号与字族写到 `body` 上,使首屏及 `bootstrapFontSizes`/`bootstrapFontFamilies` 与作用域随后采纳的值一致。markdown 字阶经 `--dsh-content-font-delta` 与 `--dsh-code-font-delta` 跟随设置,锚定本分叉的本地字阶而非上游绝对值。侧栏终端消费自身角色且不替换存活中的 xterm 实例,仅在可见可写终端的几何变化时重排版。

**作用域 decode 解析账户裸层。** `account-or-host` 绑定声明 `decode: decodeThemeSection`,将每份 section 经 `ThemeSettingsSchema` 解析。账户偏好镜像可能发布早于字体字段的 section(其 `ui-theme` 白名单仅含 `preference`),而复合合并在 Host 层尚未就绪时会把这份裸 section 透出;schema 解析会补齐缺失字段,使两条通道上的 `getSnapshot().value` 都维持文档所述的"schema 解析后 section"契约([字段路由](2026-10-03-account-or-host-field-routing.md))。

## Alternatives considered

**在消费端容忍缺字段。** 在 `durableFontFamilies` 与 `sectionFontSizes` 里读 `section.textFontFamily ?? ''` 会在读取点复制 schema 的默认表,并让每个后续消费方重新发现同一个缺口;在作用域边界解析才是该作用域已文档化的契约。

**在 `mergeSectionLayer` 内补全 section。** 合并在 Host 层缺席时无从知道完整 section 需要哪些字段——它没有 schema——因此要么扣留一份本就完整的纯账户 section(`locale` 无需 Host 即完整),要么继续漏出残缺 section。

**独立的字体设置命名空间。** 拆段可让各行写互不重叠的文档,但偏好与字体字段是同一个面向用户的主题选择;单段让采纳、版本围栏与启动脚本的持久读取保持原子。

## Consequences

- `ThemeRuntime` 拥有 `setFontSize`/`setFontFamily` 与全角色 `adjustFontSizes`;固定目录动作 `fontSize.increase`/`fontSize.decrease` 仅在桌面快捷键运行时存在。
- `ui-theme` 段现在在 `preference` 旁持久化六个字体字段;早于这些字段写入的文档在读取时解析为默认值。
- `packages/client/ui-settings` 无改动:既有 `decode` 钩子即此接缝,本特性是其首个依赖 schema 解析而非裸对象接受的树内消费方。
- 设置 e2e(`settings-chrome`)在两份对话框 golden 中记录字体行,并对着真实 Host 文档证明写入、重载持久与复位。

## Verification

`packages/client/ui-theme` 单测与 apply spec 覆盖 store 同步、按角色写入、未决写入围栏、跨平台快捷键匹配与 HMR 拆卸;`ui-layout` presenter spec 覆盖变量写入与撤除;终端 spec 覆盖字族/字号消费与重排版门控。web e2e 对真实设置文档做端到端验证。本改动通过 typecheck、lint、unknown-cast 门禁与翻译配对检查。
