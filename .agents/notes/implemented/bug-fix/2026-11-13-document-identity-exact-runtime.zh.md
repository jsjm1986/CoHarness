# Agent Note: Document identity carries the exact runtime allocation

Status: implemented

[English](2026-11-13-document-identity-exact-runtime.md) | 中文

## Problem

在多节点舰队下，受管 Web 客户端永远无法完成启动：每次 `/` 导航都会被落地解析器重定向到 `/?dshRuntime=<id>`，但 `__DSH_DOCUMENT_IDENTITY__` 只嵌入了 scope 级目标（`{kind:'personal'}` 或 `{kind:'project',projectId}`)。浏览器 identity fence 把「bootstrap `dshRuntime` 存在而 document target 不携带精确分配」视作账户变更（`setRuntimeTarget` 要求 `target.runtimeId` 等于钉住的 id)，于是 `installConnection` 在 `apply` 期间抛出 `BrowserIdentityChanged`,`dsh-client-connection` 标记 failed，全部 57 个 UI entry 滞留 pending,`invalidate()` 又触发页面重载进入同一失败——无限白屏重启循环。

即使不带显式选择器，失败同样是全量的：fence 给 scope 敏感请求只钉 `dshTarget=personal`，而当账户在多节点上拥有同 scope kind 的多个 runtime 时，catalog 正确返回 `runtime-catalog/ambiguous-target`(HTTP 409)，于是所有 `/api/*` 调用全部失败。只有每个 scope kind 恰好一个 runtime 的账户才能启动，这正是该缺陷能通过单节点验证幸存下来的原因。

## Decision

document identity 现在端到端携带已认证 index 响应所选的精确 runtime 分配：

- [GatewayRuntime](../../../../packages/context/gateway-runtime/src/index.ts) 在注入的 `__DSH_DOCUMENT_IDENTITY__.runtimeTarget` 中展开 `claims.runtime.runtimeId`（当已验证断言命名了精确分配时）；遗留单分配组合保持 scope 级目标不变。
- [parseDocumentIdentity](../../../../packages/client/connection/src/client/document-identity.ts) 在两种 target kind 上接受可选的非空字符串 `runtimeId` 并拆解进 `ClientRuntimeLocation`；未知 target 键、空或非字符串 runtime id、携带权限的字段仍然被拒绝。

fence 随后以 `dshTarget=<scope>&dshRuntime=<精确 id>` 钉住所有 scope 敏感请求与 socket，与已声明的 `host.describe.runtimeTarget` wire schema 及 runtime 侧 `describe` 发射保持一致，bootstrap 握手因此重新确认同一分配而不是判其失效。

## Alternatives considered

**移除 `dshRuntime` bootstrap 校验。** 该校验是 identity fence 对「HTML document 绑定到与 URL 宣称不符的 runtime」的防护；移除会让过期或重放的 document 静默钉住另一分配。

**仅在 URL 带 `dshRuntime` 时发射 `runtimeId`。** identity 描述的是应答的 runtime 而非请求文本；catalog 解析出的落地（裸 `/`）在后续 ambiguous-catalog 请求上同样需要精确钉住。

**把 `dshTarget=personal` 解析到 home 节点。** 当多个分配拥有同一 scope 时，歧义是 catalog 的正确答案；凭空合成偏好会把请求钉到任意 runtime，并偏离 `resolveForAccount` 语义。

## Consequences

多节点舰队下任意账户、任意 runtime 密度都能启动受管 Web 客户端；scope 级钉住只对无分配 id 启动的 runtime 保留为退路。同一 `runtimeId` 现在经三条通道到达（document identity、`host.describe`、请求钉住），都由 `runtimeTargetKey` 比对，因此不匹配的转发仍会判 document 失效而不是漂移。

## Verification

- `gateway-admission.host.spec.ts` 为带分配的断言渲染 `{kind:'personal',runtimeId}`，对遗留断言保持 scope 级目标。
- `document-identity.client.spec.ts` 接受携带 runtimeId 的 target，并拒绝畸形或多键输入。
- 已部署舰队实测：`https://harness.maycran.com/?dshRuntime=<id>` 服务出 `runtimeTarget:{kind:'personal',runtimeId:<id>}`,Chrome 完整启动 UI——侧栏节点列表、会话列表、工作台——取代了此前的 `web boot: 57 entries did not activate` 循环。
