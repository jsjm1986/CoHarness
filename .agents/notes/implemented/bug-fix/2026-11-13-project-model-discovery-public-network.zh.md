# Agent Note：将非管理员项目模型发现限制为公网地址

状态：已实现

[English](2026-11-13-project-model-discovery-public-network.md) | 中文

## 问题

`POST /account/api/projects/:id/model-settings/discover` 接受项目所有者提供的任意 `baseURL`，并由 Gateway 进程通过全局 `fetch` 请求该地址。非管理员因此可以让 Gateway 请求回环、私有、链路本地或云元数据地址，而 `accountProjectError` 会返回上游错误消息，其中包含 URL、状态和响应正文文本。

## 决策

[discovery.ts](../../../../packages/llm/llm/src/discovery.ts) 接受可选的 `fetch`，用于每个列表请求，包括同源重定向。[public-network-fetch.ts](../../../../gateway/src/public-network-fetch.ts) 提供基于 Node `http`/`https` 的请求，并替换 `lookup`：它解析主机的全部地址，只要有一个不是公网单播地址就以 `NonPublicNetworkTargetError` 失败，因此套接字只连接已检查的地址，校验后变化的 DNS 应答无法到达私有地址。IP 字面量在请求前检查，且不使用代理 agent。IPv4 映射、NAT64、6to4 和 Teredo IPv6 网段直接拒绝，不做解码。`discoverOrganizationModels` 需要必填的 `allowPrivateNetwork`；仅管理员可用的组织发现传入 `true`，项目路由传入 `user.role === 'admin'`。对非管理员，项目路由将除授权和发布可用性错误以外的所有发现失败替换为 `model-discovery-target-not-public` 或 `model-discovery-failed`。

## 备选方案

**在调用全局 `fetch` 前校验解析后的主机名。** 已拒绝：`fetch` 会再次解析，校验与连接之间变化的 DNS 应答会绕过检查。

**管理员配置的端点允许列表。** 本次修复不采用：它需要新的配置和管理界面，而公网地址限制无需改变项目所有者使用公网 Provider 的方式即可关闭该请求路径。

## 影响

非 Gateway 管理员的项目所有者不能再从私有网络中的自托管端点发现模型；管理员保留该能力。对已保存项目 Provider `baseURL` 的运行时模型请求不经过此 fetch。

## 验证

`gateway/tests/public-network-fetch.spec.ts` 对地址分类，证明 `localhost`、`127.0.0.1` 和 `[::1]` 在任何监听器收到请求前被拒绝，并证明 `allowPrivateNetwork: true` 仍可到达监听器。`gateway/tests/project-model-settings.spec.ts` 检查路由按角色传入 `allowPrivateNetwork`，并对非管理员隐藏上游消息。`packages/llm/llm/tests/discovery.spec.ts` 检查重定向使用提供的 `fetch`。
