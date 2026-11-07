# Agent Note: 受管 Runtime 就绪要求策略插件已激活

Status: implemented

[English](2026-10-31-managed-runtime-policy-readiness.md) | 中文

## Problem

Runtime 可能在资源注册后通过就绪响应鉴权，而必需的授权插件却导入失败。签名进程身份只能证明由哪个进程响应，不能证明策略组合已经激活。

## Decision

Gateway 组合在 `gateway-runtime.requiredPlugins` 中配置模型治理、执行授权和启用的目录守卫。每个配置的 Loader 条目 id 必须恰好对应一个已激活条目。缺失、等待、失败、停用或存在歧义的条目使经过鉴权的就绪探测返回 HTTP 503。资源提供者就绪和现有 HMAC 身份证明仍然必需。未配置条目 id 的组合保留仅检查资源提供者的行为。

该列表归部署组合所有，Runtime 不维护策略包名称的全局表。[策略产物访问决策](2026-10-31-runtime-policy-artifact-readability.zh.md) 仍独立成立：代码可读允许激活，但不能证明已经激活。

## Alternatives considered

**只接受监听端口或签名身份。** 两者都不能证明策略可用。

**要求所有配置插件都成功。** 可选功能失败会阻止其他部分有效的环境启动。

**把策略名称加入引导器的全局必需列表。** 通用应用启动器将被迫负责 Gateway 策略组合，而且在引导审查结束前仍不能保护就绪判断。

## Consequences

就绪检查在每次探测时读取当前 Loader 状态，不保留激活缓存。Loader 缺失时拒绝配置的要求。关闭目录守卫不会取消模型和执行要求。请求时授权仍有最终效力；就绪检查不替代权限校验，也不证明曾经就绪的进程会一直健康。Runtime 身份、私有凭据和耐久数据格式不变。
