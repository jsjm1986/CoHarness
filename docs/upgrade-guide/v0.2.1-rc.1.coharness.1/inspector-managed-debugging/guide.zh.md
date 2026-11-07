---
kind: upgrade-guide
description: "不受限的 Inspector 调试只支持独立本地运行时。"
---

# 将不受限调试保留在受管运行时之外

[English](guide.md) | 中文

## Change

存在或要求执行权限 provider 时，Inspector Host 插件会拒绝启动。此前，普通的已认证项目用户可以访问支持任意 Host 和 Client 求值、未脱敏网络采集的 CDP 代理。

启动期间安装执行权限会取消准入并返还未使用的资源许可。Inspector 运行时安装权限会阻止其传输，并关闭已有代理连接和 Worker。清理失败时保留原归属供重试。撤下策略不会重新激活该 Inspector 实例。

## Migration

1. 从共享受管运行时的 profile 移除不受限的 Inspector，只在独立本地开发 profile 中保留。项目身份认证不足以授权 Host 调试。
2. 部署匹配的 Inspector 包和 Worker。不需要迁移 Session 或数据库。
3. 验证受管组合拒绝 Inspector 启动，而独立开发仍可打开经过身份认证的调试器。参见[安全参考](../../../../packages/experimental/inspector/README.zh.md#security)。
