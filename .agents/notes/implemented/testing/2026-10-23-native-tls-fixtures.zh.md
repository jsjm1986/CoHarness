# Agent Note: 使用原生密码学生成一次性 TLS 测试材料

Status: implemented

[English](2026-10-23-native-tls-fixtures.md) | 中文

## Problem

TLS 集成测试需要可供客户端验证、覆盖 localhost 和两种回环 IP 的证书。提交私钥会让一次性测试材料难以与泄露凭据区分。测试材料依赖也需要维护中的密码学实现，避免继续依赖仅用于测试的 node-forge。异步生成 API 和证书有效期选项必须在各个消费者间保持一致。

## Decision

[WebServer TLS 测试助手](../../../../packages/host/webserver/tests/tls-fixture.ts) 使用基于原生 WebCrypto 和 `@peculiar/x509` 的 `selfsigned` 5.5。同一进程共用待完成的生成操作，每次材料落盘都会等待它，生成失败后允许再次尝试。现有异步测试助手 API 继续服务 WebServer 和构建后的 Web profile 测试。

证书使用 RSA-2048 和 SHA-256，显式设置相差三十天的起止时间，并保留针对 `localhost`、`127.0.0.1` 和 `::1` 的服务器认证扩展。助手仅向调用方拥有的临时目录写入材料，私钥只允许属主读取。真实 TLS 测试要求生成的信任锚；未配置该信任锚的客户端会拒绝服务器。

## Alternatives considered

**保留同步生成器。** 4.x 依赖会让 node-forge 留在测试依赖图内。5.5 通过异步 API 支持所需扩展，因此调用方等待生成结果，无需保留旧依赖。

**提交固定证书和私钥。** 每份仓库检出都会保留私钥材料，证书最终还会过期。临时生成让信任锚仅属于当前测试进程。

## Consequences

测试依赖图无需 override 即可解析为一个 `@peculiar/asn1-schema` 版本。验证覆盖实际扩展构造和启用验证的 HTTPS 握手，仅凭包版本去重不足以证明证书可用。集成用例检查三个名称和三十天有效期。生产证书配置和监听器策略保持不变。
