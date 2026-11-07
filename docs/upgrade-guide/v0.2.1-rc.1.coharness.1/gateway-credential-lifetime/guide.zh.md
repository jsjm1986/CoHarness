---
kind: upgrade-guide
description: "Gateway 启动凭据在提供方替换后仍绑定到其所属应用。"
---

# 升级 Gateway 凭据生命周期

[English](guide.md) | 中文

## 变更

Gateway 运行时应用在提供方和模块替换期间保留首次验证通过的启动凭据及已解码的验证公钥。替换时不会再次读取一次性描述符。其他应用不能继承这个保留身份，首次读取失败仍然可以修复。应用关闭时释放私有保留值。

损坏的凭据 JSON 和 origin 错误使用不含输入内容的验证诊断。规范 IPv6 回环 origin 与原有 IPv4、localhost 形式一并接受；仅限 HTTP 和精确 origin 的限制仍然生效。

## 操作

重新构建 `@deepseek-ai/dsh-gateway-runtime` 并部署其编译产物，然后对已有托管运行时执行一次重启。变更组织、Runtime 分配或 generation 需要新应用；修改凭据文件或环境不能为已有应用重新绑定身份。不需要迁移持久数据或请求模型。
