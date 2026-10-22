---
kind: upgrade-guide
description: "自定义原始 Web 组合必须挂载 Plugin Manager 目录入口，插件页才能读取数据。"
---

# 插件管理目录入口

[English](guide.md) | 中文

## 变更

Web 与 Admin 插件页通过 `pluginManager/catalog` 读取可用性、变更权限、组合包与条目。只挂载旧管理器和清单入口的自定义原始 Web 组合，还必须挂载 `@deepseek-ai/dsh-plugin-manager/catalog`；入口缺失时页面报错，不回退到旧读取方式。现有管理读取与变更端点继续可用。

随附的 `web-app` patch 包含新的只读入口。共享 base、headless 与 SDK 组合保留原有提供者。[包参考](../../../../packages/boot/plugin-manager/README.zh.md#use-this-package)说明未托管 profile 与授权行为。

## 迁移

1. 同时升级 Web Host（包括 `dsh-gateway-runtime`）、Client 与 Admin 产物，并通过现有构建重新生成 Typert 产物。运行时的 `plugin-admin` 允许列表必须放行目录 POST 路由。重新加载已有浏览器页面。
2. 对自定义原始 Web 树，在其解析器 manifest 中依赖匹配版本的 `@deepseek-ai/dsh-plugin-manager`，并向 `cordis.yml` 或拥有该树的 patch 加入普通插件行：

   ```yaml
   - id: plugin-manager-catalog
     name: '@deepseek-ai/dsh-plugin-manager/catalog'
   ```

3. 打开**插件**并选择**刷新**。页面读取一次 `pluginManager/catalog` 响应：受管 profile 按调用者权限显示原有卡片；未托管 Web Host 显示不可用。拒绝读取时保持拒绝状态。没有新入口的 Host 显示错误，需要修正组合。
