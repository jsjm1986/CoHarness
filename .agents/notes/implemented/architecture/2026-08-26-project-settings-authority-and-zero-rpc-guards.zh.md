# Agent Note：项目设置权限与零 RPC 写入保护

Status: implemented

[English](2026-08-26-project-settings-authority-and-zero-rpc-guards.md) | 中文

## Problem

项目会话从共享 Host 运行时读取当前有效设置，个人会话则拥有可写的用户层。如果设置控件只等待服务端拒绝，就可能先显示误导性的本地选择、发出必然失败的 mutation，并在传输失败后与行持有的状态脱节。同一轮 UI 发布还暴露了缺少静态检查的 CSS 名称与移动端 API 回退路径。

## Decision

当 `writable` 为 false 时，settings describe 应答携带 `writableReason: project | provider`。浏览器 scope 将该权限信息与 `loading`、`ready` 或 `unavailable` 状态，以及 `write` 状态（`idle`、`saving`、`blocked`、`error`）一起发布。scope 会在 mutation 入队前再次检查当前快照，因此 loading、unavailable、project 与 provider 状态不会产生 mutation RPC；每个排队操作都会重新检查权限，最新写入被拒绝或传输失败后会恢复持有的 Host 视图。

主题、locale 与忙碌 Enter 行在 scope 取得可用视图前保持禁用；服务在已知的 ready 视图为只读时也会拒绝直接变更。若权限仍未知时有调用抵达，scope 会丢弃写入且不发线路请求，之后的 Host 视图会采用持久值。各行禁用时关闭打开的菜单，并以双语行内状态显示 loading、saving、只读、不可用与写入失败。共享 settings mirror 仍是唯一的 `settings.describe` 读取方，因此权限变化只增加订阅与快照工作，不增加每一行的读取。Agent preset 在 roster 不可写时也在客户端停止 mutation。明确标记为 `projectWrite: manager` 的项目 namespace 是例外：项目 owner 和组织管理员可以通过认证的项目界面写入；其他项目 namespace 继续使用零 RPC 保护，所有权与 transport 分离记录在[项目作用域设置管理](../feature/2026-08-28-project-scoped-settings-management.zh.md)。

CSS 消费方使用已有的 canonical design token。静态测试扫描已发布的 `--ds-*` 与 `--dsw-*` 引用并与声明比对；可视视口变量是明确的运行时例外。移动端表层使用 `100vh` 回退，并通过共享视口变量在支持时采用 `dvh`。媒体查询监听器同时支持标准 API 与旧版 WebView API，浮层持有方使用原生 inert 加 `aria-hidden`／tab 停靠点回退。

## Alternatives considered

**只依赖服务端拒绝。** Host 仍是最终授权方，但等待拒绝会产生无意义的网络工作，并允许乐观值暂时违背项目有效设置。客户端保护提供快速路径，不削弱 Host 检查。

**写入失败后保留本地偏好。** 写入等待期间可以显示本地值，但恢复后继续保留会让浏览器与持久来源不一致。因此最新失败写入会重新读取并采用 Host 应答。

**让每个功能自行调用 `settings.describe`。** 独立读取会增加冷启动延迟，并可能在失效期间互相不一致。单一 mirror 保持启动 RPC 预算，也让每个 scope 使用同一条 revision 流。

**为缺失 token 增加兼容别名。** 别名会掩盖拼写漂移并使主题所有权变得含糊。代码改用既有 canonical token，并用静态引用检查阻止新的悬空名称。

## Consequences

个人设置仍可通过 Host 提供方写入，项目设置则按明确声明分为管理员可写或可读且不可变。被阻止的选择只更新本地快照状态，不发 mutation 请求，因而成本可控且确定。成功写入仍直接把应答折入 mirror，不新增第二次 describe 读取，保留性能敏感路径。新增状态与兼容辅助函数扩大了包契约和测试范围；以后新增设计变量或运行时 CSS 变量必须提供声明，或加入明确的例外列表。生产认证浏览器验收仍属于部署验证，不由单元测试保证。
