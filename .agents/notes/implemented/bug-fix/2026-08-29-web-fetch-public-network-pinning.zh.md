# Agent Note: 将 WebFetch 请求固定到已校验的公网地址

Status: implemented

[English](2026-08-29-web-fetch-public-network-pinning.md) | 中文

## Problem

在连接时才进行 DNS 解析的 HTTP 抓取提供方可能访问 loopback 或私有服务；DNS rebinding 还可以在首次策略检查后改变主机名对应的地址。重定向到新目标时会再次产生相同风险。

## Decision

HTTP 抓取提供方在建立连接前解析每个主机名，答案集合中只要有一个非公网地址就全部拒绝，并使用只返回已校验地址的 Undici dispatcher lookup 回调。IPv4、IPv6、映射地址和 DNS64 转换都会检查；同源重定向的每一跳都会重新解析和校验。提供方保留现有响应、超时、大小和 approval 行为，不为测试或私有部署放宽策略；需要有意访问私网时必须使用单独的提供方。

## Alternatives considered

**只校验字面 IP。** 不采用，因为普通主机名和 DNS rebinding 仍可访问。

**只解析一次，然后让默认 HTTP 客户端再次解析。** 不采用，因为第二次解析可能返回不同的私有地址。

**通过宽泛配置开关允许私有地址。** 不采用，因为部署错误会把面向模型的工具变成不受限制的 SSRF 原语。

## Consequences

公网 WebFetch 请求会增加一次 DNS 查询，并为每个请求使用短生命周期 dispatcher。含有公网和私网混合答案的主机名会整体拒绝，而不是部分使用。测试和本地 fixture 显式注入已校验的 resolver；生产默认保持 fail-closed。

## Testing

网络测试覆盖公网地址分类、空和畸形 DNS 答案、DNS rebinding、DNS64 转换、取消、固定 lookup 的地址族选择、重定向重新校验和响应清理。既有抓取行为测试使用显式 loopback resolver fixture。
