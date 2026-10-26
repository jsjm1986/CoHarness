# Agent Note: 已认证页面身份允许并行建立连接

Status: implemented

[English](2026-10-27-authenticated-document-handshake.md) | 中文

## Problem

浏览器在开放依赖作用域的请求和事件 socket 前固定页面账号与引导 Runtime。若仅从 `host.describe` 获取这些事实，两段网络过程会串行发生，即使已认证的 index 已经属于同一账号与 Runtime。公网导航记录在共享应用代码命中浏览器缓存时仍显示这条依赖；消除脚本传输本身不能证明对话启动更快。

## Decision

[Index 渲染器](../../../../packages/host/webserver/README.zh.md) 将可选的当前 HTTP 请求传给结构化注入监听器，不提供认证裁决或请求上下文。[GatewayRuntime](../../../../packages/context/gateway-runtime/README.zh.md) 验证该请求的签名 principal，包括用途、组织、作用域和 Runtime generation，然后仅输出版本 1、账号 ID 与 Runtime 目标。非请求专属收集不输出身份。注册归插件 fiber 所有，随卸载撤回。[Frontend-static](../../../../packages/host/frontend-static/README.zh.md) 先认证、后渲染，并为 index 响应设置 `no-store`；带内容哈希的资源保留独立的 immutable 缓存策略。

[Connection](../../../../packages/client/connection/README.zh.md) 校验 HTML 输入，并复制到页面所有的身份围栏。存在但畸形的输入使加载失败；输入缺省时保留先描述、后初始化的顺序，fixture 与显式载体忽略这份 HTTP 输入。序列化的启动值是页面输入，不是共享响应缓存，不包含凭据、断言、权限或 Host 描述。

围栏将请求与 socket 固定到该账号和 Runtime，两条事件 socket 与 `host.describe` 同时建立。每个 API 请求和 upgrade 仍独立认证。预期账号 ID 只构成拒绝条件，不能授予身份；响应账号或描述中的 Runtime 不一致时，页面失效并关闭所属连接。[浏览器认证决策](2026-10-01-browser-auth-web-transport.zh.md) 继续拥有准入与用途策略。

[双流载体](2026-08-04-websocket-downlink-carrier.zh.md) 仍等待描述与两条物理连接全部就绪，才发布 connected 状态或释放缓冲业务帧。既有 reset 与重放顺序保持不变。设置仍执行提前读取及订阅后的最新基线读取。页面身份固定不验证账号目录，也不授权恢复私有布局：[principal 所有的布局](2026-09-23-principal-owned-workbench-layouts.zh.md) 与[初始 Workspace 选择](../bug-fix/2026-10-24-bootstrap-runtime-initial-selection.zh.md) 决策继续约束这些行为。

## Alternatives considered

**从 Cookie、浏览器保留状态或 URL 推断账号与 Runtime。** 这些值可能属于另一个标签页、账号或 Runtime。只有已认证的响应提供本页面的输入，后续操作仍重新授权。

**Socket 打开后立即发布 connected。** Upgrade 成功不代表 Host 描述和两条流的基线全部成立。业务状态仍等待所有既有就绪检查。

**订阅后复用提前读取的设置结果。** 读取与流订阅之间的提交可能被漏掉。提前准入请求不能替代最新基线。

**在 Gateway 代理内重写 HTML。** 对上游响应进行缓冲、解压和改写会增加另一个渲染所有者。前端已有的结构化注入路径已经拥有页面输入。

## Verification

聚焦回归在暂停描述响应时观察个人和项目目标的 socket 建立；原实现中两条连接均未开始。客户端用例保留重放顺序，并在账号或 Runtime 不一致时关闭提前建立的 socket。真实签名 Loader 组合覆盖共享项目 Runtime 内每请求的账号 ID、凭据排除、`no-store`、非请求专属收集、全部既有准入拒绝与注册释放。组装后的无密钥 Web 用例在暂停描述响应时使用真实 socket，观察就绪前没有 Session 或 Workspace 基线，并对比可见模型和可编辑输入框的预期输出。该 fixture 仅提供外部 Gateway 身份；签名数据生产者由独立的真实组合检查覆盖。

## Consequences

移除一段网络依赖，不增加请求、计时器、保留响应、数据迁移或任务数量限制。源码顺序和功能检查不能证明完整响应时间改善；公网前后导航仍须独立测量，并注明浏览器与 Runtime 的缓存状态。
