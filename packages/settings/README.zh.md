# settings/：用户设置能力族

[English](README.md) | 中文

该包族通过注册的命名空间与可替换存储提供方解析用户可编辑配置。

| 包 | 职责 | ctx key |
|---|---|---|
| [`settings/`](settings/README.zh.md) | 定义命名空间注册、分层解析与提交 | `ctx.settings` |
| [`settings-file/`](settings-file/README.zh.md) | 在本地文件中存储设置并观察外部编辑 | 注册到 `ctx.settings` |

子系统参考——命名空间、owner scope、解析顺序、热提交——见 [docs/subsystems/settings.md](../../docs/subsystems/settings.zh.md)。


## 概述

`settings/` 组让插件配置变为用户可编辑：插件用一个 schema 注册具名 namespace，用户在一份文档里覆盖值，无需改动 `cordis.yml`。用户覆盖优先于部署自身的配置与 schema 默认值，变更实时生效。两个包覆盖该能力：`settings/` 提供设置服务，`settings-file/` 把所有 namespace 存进一个用户可编辑的 YAML 或 JSON 文档。设置是可选的：没有挂载提供方时，配置保持组合原样。
